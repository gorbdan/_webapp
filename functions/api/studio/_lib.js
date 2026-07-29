// Студия нейромультиков — общая обвязка для /api/studio/* (Pages Functions).
// ТЗ: docs/specs/2026-07-20_cartoon_studio.md в репо бота.
// Файлы с "_" не роутятся Pages — это библиотека, не эндпоинт.

export function json(body, status = 200) {
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
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msgBytes));
}

// Официальный алгоритм Telegram "Validating data received via the Mini App".
// В отличие от answer-webapp-query, query_id НЕ обязателен (студия работает
// при любом способе открытия вебапа) — обязателен user.id. user_id берётся
// ТОЛЬКО отсюда, никогда из тела запроса (ревизия п.7 ТЗ). initData старше
// 24ч — отказ.
//
// Живой баг 2026-07-28 (Аня): "сессия устарела" на каком-то из действий, не
// на первом — при том, что проверка детерминирована (тот же initData даёт
// тот же результат всегда). Подозрение: tg.initData на телефоне может стать
// пустым на миг при сворачивании/разблокировке во время долгой генерации
// клипа, и фоновый 4с-поллинг статуса попадает в это окно. Возвращаем ПРИЧИНУ
// отказа (не просто null) — логируется в роутере через console.error,
// смотреть в Cloudflare Observability → Logs при повторном воспроизведении.
export async function verifyStudioUser(initData, botToken) {
  const raw = String(initData || "");
  if (!raw) return { reason: "empty_init_data" };

  const params = new URLSearchParams(raw);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { reason: "no_hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, enc.encode(dataCheckString)));
  if (calculatedHash !== receivedHash) return { reason: "hash_mismatch" };

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return { reason: "stale_auth_date", authDate };

  let user;
  try {
    user = JSON.parse(params.get("user") || "");
  } catch {
    return { reason: "bad_user_json" };
  }
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { reason: "bad_user_id" };
  return { ok: true, userId };
}

export function checkBotSecret(request, env) {
  const secret = String(env.STUDIO_POLL_SECRET || "");
  if (!secret) return false;
  const got = request.headers.get("X-Studio-Secret") || "";
  return got === secret;
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// Владелец проекта — каждая операция вебаппа проверяет (ревизия п.7)
export async function getOwnedProject(db, projectId, userId) {
  if (!projectId) return null;
  return await db
    .prepare("SELECT * FROM studio_projects WHERE id = ? AND user_id = ?")
    .bind(String(projectId), userId)
    .first();
}

export async function getConfig(db, key) {
  const row = await db.prepare("SELECT value FROM studio_config WHERE key = ?").bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export async function setConfig(db, key, value) {
  await db
    .prepare(
      "INSERT INTO studio_config (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), nowIso())
    .run();
}
