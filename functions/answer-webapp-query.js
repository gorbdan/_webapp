// Cloudflare Pages Function — 1-тап «Использовать» для вебаппа, открытого
// с ИНЛАЙН-кнопки бота (там нет reply-клавиатуры, поэтому tg.sendData()
// недоступен — см. docs/BOT_CONTRACT.md в репо бота, раздел «Инлайн-путь
// «Использовать» в 1 тап», архитектурное решение 2026-07-16, вариант B).
//
// Секрет BOT_TOKEN заводится в Cloudflare Pages отдельно (Аня) — тот же
// токен, что в BotHost. Без него функция всегда отвечает 500.

const TELEGRAM_API_BASE = "https://api.telegram.org";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(keyBytes, msgBytes) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgBytes);
  return new Uint8Array(signature);
}

// Официальный алгоритм Telegram "Validating data received via the Mini App":
// secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
// hash = HEX(HMAC_SHA256(key=secret_key, message=data_check_string))
async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { valid: false };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, enc.encode(dataCheckString)));

  if (calculatedHash !== receivedHash) return { valid: false };

  const queryId = params.get("query_id");
  if (!queryId) return { valid: false, reason: "no_query_id" };

  return { valid: true, queryId };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.BOT_TOKEN) {
    console.error("answer-webapp-query: BOT_TOKEN secret is not configured");
    return jsonResponse({ ok: false, error: "server_misconfigured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const initData = String(body?.init_data || "");
  const catIdx = Number(body?.cat_idx);
  const itemIdx = Number(body?.item_idx);

  if (!initData || !Number.isInteger(catIdx) || catIdx < 0 || !Number.isInteger(itemIdx) || itemIdx < 0) {
    return jsonResponse({ ok: false, error: "bad_request" }, 400);
  }

  const verified = await verifyInitData(initData, env.BOT_TOKEN);
  if (!verified.valid) {
    return jsonResponse({ ok: false, error: "invalid_init_data" }, 401);
  }

  // callback_data — уже штатный формат, который button_handler в SirNike.py
  // обрабатывает веткой pl_use_ (тот же путь, что у инлайн-каталога библиотеки
  // внутри бота). Дублировать логику применения стиля не нужно.
  const callbackData = `pl_use_${catIdx}_${itemIdx}`;
  // note НЕ помещается в callback_data (лимит Telegram — 64 байта) — если он
  // заполнен, этот 1-тап путь его не доставит. Принятое ограничение: у
  // input_hint-стилей (редкий случай) есть обычный 2-таповый путь через
  // reply-клавиатуру, где note доставляется полностью через set_prompt_ref.

  const answerPayload = {
    web_app_query_id: verified.queryId,
    result: {
      type: "article",
      id: `pl_use_${catIdx}_${itemIdx}`,
      title: "Использовать стиль",
      input_message_content: { message_text: "📚 Стиль подобран — жми ниже 👇" },
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Использовать", callback_data: callbackData }]],
      },
    },
  };

  let tgRes;
  try {
    tgRes = await fetch(`${TELEGRAM_API_BASE}/bot${env.BOT_TOKEN}/answerWebAppQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answerPayload),
    });
  } catch (e) {
    console.error("answerWebAppQuery fetch failed", e);
    return jsonResponse({ ok: false, error: "telegram_unreachable" }, 502);
  }

  const tgData = await tgRes.json().catch(() => ({}));
  if (!tgRes.ok || !tgData.ok) {
    console.error("answerWebAppQuery rejected by Telegram", tgRes.status, tgData);
    return jsonResponse({ ok: false, error: tgData.description || "telegram_error" }, 502);
  }

  return jsonResponse({ ok: true });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
}
