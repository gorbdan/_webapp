// Cloudflare Pages Function — генеральный (не только 1-тап библиотеки, как
// answer-webapp-query.js) путь доставки payload из вебаппа, открытого с
// ИНЛАЙН-кнопки бота — включая каждую кнопку «✏️ Изменить» на карточке
// подтверждения (это по определению контекст конкретного сообщения, у неё
// нет и не может быть reply-клавиатурной альтернативы).
//
// По официальной документации Telegram Bot API, tg.sendData() работает
// только для Mini App, открытого с reply-клавиатуры/Menu Button;
// InlineKeyboardButton(web_app=...) обязан использовать answerWebAppQuery.
// answer-webapp-query.js (соседний файл) уже решает эту же проблему для
// 1-тапа библиотеки, но кодирует данные в callback_data (жёсткий лимит
// Telegram — 64 БАЙТА) — payload'ы хаба генерации (описание + до 9 фото-
// референсов) в него не влезают никак.
//
// Решение: полный JSON-payload кладём в message_text результата
// answerWebAppQuery (лимит Telegram на текст сообщения — 4096 СИМВОЛОВ,
// тот же порядок величины, что у sendData). Telegram доставляет боту это
// как обычное текстовое сообщение с `via_bot = сам бот, message_id = X` —
// бот (handle_text, SirNike.py) распознаёт валидный JSON с полем
// action/a, прогоняет через apply_webapp_prompt_payload_v2 (ТОТ ЖЕ
// диспетчер, что и sendData-путь — video/photo/avatar/midjourney/
// set_active_avatar и т.д., ничего не дублируется) и сразу удаляет
// исходное JSON-сообщение — юзер не видит сырой JSON в чате, только
// привычную карточку подтверждения следом.
//
// Секрет BOT_TOKEN — тот же, что уже заведён для answer-webapp-query.js
// (Cloudflare Pages → Settings → Environment variables).

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_PAYLOAD_TEXT_LENGTH = 4000; // с запасом от лимита Telegram в 4096

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

// Официальный алгоритм Telegram "Validating data received via the Mini App"
// (тот же код, что в answer-webapp-query.js — не выносила в общий модуль,
// т.к. Cloudflare Pages Functions здесь без сборки, дублирование дешевле
// инфраструктуры под shared-модуль ради ~20 строк).
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
    console.error("answer-webapp-payload: BOT_TOKEN secret is not configured");
    return jsonResponse({ ok: false, error: "server_misconfigured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const initData = String(body?.init_data || "");
  const payload = body?.payload;
  if (!initData || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonResponse({ ok: false, error: "bad_request" }, 400);
  }

  const verified = await verifyInitData(initData, env.BOT_TOKEN);
  if (!verified.valid) {
    return jsonResponse({ ok: false, error: "invalid_init_data" }, 401);
  }

  const text = JSON.stringify(payload);
  if (text.length > MAX_PAYLOAD_TEXT_LENGTH) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  const answerPayload = {
    web_app_query_id: verified.queryId,
    result: {
      type: "article",
      id: `gp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: "Отправка",
      input_message_content: { message_text: text },
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
    console.error("answer-webapp-payload: answerWebAppQuery fetch failed", e);
    return jsonResponse({ ok: false, error: "telegram_unreachable" }, 502);
  }

  const tgData = await tgRes.json().catch(() => ({}));
  if (!tgRes.ok || !tgData.ok) {
    console.error("answer-webapp-payload: answerWebAppQuery rejected", tgRes.status, tgData);
    return jsonResponse({ ok: false, error: tgData.description || "telegram_error" }, 502);
  }

  return jsonResponse({ ok: true });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
}
