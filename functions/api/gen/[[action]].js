// «Всё в вебаппе»: генерация по HTTP-очереди вместо tg.sendData (который
// закрывает Mini App). ТЗ: docs/specs/2026-11-16_webapp_gen_transport.md в репо бота.
// Схема D1: db/gen_jobs_schema.sql.
//
//  - вебапп: заголовка нет, личность из init_data (HMAC, как у студии):
//      submit  — положить задание; status — узнать, принял ли его бот; ready — доступна ли схема
//  - бот: заголовок X-Studio-Secret (тот же STUDIO_POLL_SECRET, что у студии):
//      poll    — забрать queued → taken; complete — отчитаться о результате
//
// «Пульс» бота: каждый poll пишет метку времени в studio_config (ключ gen_last_poll).
// submit/ready отвечают «бот не на связи» (503/available:false), если пульса нет
// дольше BOT_ALIVE_SECONDS. Так вебапп сам откатывается на старый sendData, пока
// WEBAPP_GEN_ENABLED на стороне бота выключен или бот лежит, и задание не
// зависает в очереди, чтобы запуститься задним числом.

import { json, verifyStudioUser, checkBotSecret, uuid, getConfig, setConfig } from "../studio/_lib.js";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ACTIVE_PER_USER = 5;
const DEDUP_SECONDS = 10;
const STALE_TAKEN_MINUTES = 10;
const MAX_JOB_ATTEMPTS = 3;
const BOT_ALIVE_SECONDS = 45;
const HEARTBEAT_WRITE_EVERY_SECONDS = 10;
const HEARTBEAT_KEY = "gen_last_poll";

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return null;
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseJsonField(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

async function botIsAlive(db) {
  try {
    const last = Number(await getConfig(db, HEARTBEAT_KEY)) || 0;
    return last > 0 && Date.now() - last < BOT_ALIVE_SECONDS * 1000;
  } catch {
    return false; // нет таблицы studio_config — считаем, что бот не на связи
  }
}

// ── Действия вебаппа ────────────────────────────────────────────

async function ready(db) {
  return json({ ok: true, available: await botIsAlive(db) });
}

async function submit(db, user, body) {
  const payload = body?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const payloadText = JSON.stringify(payload);
  if (new TextEncoder().encode(payloadText).length > MAX_PAYLOAD_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }
  if (!(await botIsAlive(db))) return json({ ok: false, error: "bot_offline" }, 503);

  const hash = await sha256Hex(payloadText);

  // Дедуп двойного тапа: тот же юзер + тот же payload за последние секунды
  const dup = await db.prepare(
    "SELECT id FROM gen_jobs WHERE user_id = ? AND payload_hash = ? " +
    "AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT 1",
  ).bind(user.userId, hash, `-${DEDUP_SECONDS} seconds`).first();
  if (dup) return json({ ok: true, job_id: dup.id, deduplicated: true });

  const active = await db.prepare(
    "SELECT COUNT(*) AS n FROM gen_jobs WHERE user_id = ? AND status IN ('queued', 'taken')",
  ).bind(user.userId).first();
  if ((active?.n || 0) >= MAX_ACTIVE_PER_USER) {
    return json({ ok: false, error: "too_many" }, 429);
  }

  const id = uuid();
  await db.prepare(
    "INSERT INTO gen_jobs (id, user_id, username, payload, payload_hash) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, user.userId, user.username, payloadText, hash).run();
  return json({ ok: true, job_id: id });
}

async function status(db, user, body) {
  const jobId = String(body?.job_id || "");
  if (!jobId) return json({ ok: false, error: "bad_request" }, 400);
  const row = await db.prepare(
    "SELECT status, error, result FROM gen_jobs WHERE id = ? AND user_id = ?",
  ).bind(jobId, user.userId).first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, status: row.status, error: row.error || "", result: parseJsonField(row.result, {}) });
}

// ── Действия бота ───────────────────────────────────────────────

async function touchHeartbeat(db) {
  try {
    const last = Number(await getConfig(db, HEARTBEAT_KEY)) || 0;
    if (Date.now() - last >= HEARTBEAT_WRITE_EVERY_SECONDS * 1000) {
      await setConfig(db, HEARTBEAT_KEY, Date.now());
    }
  } catch (e) {
    console.error("gen heartbeat failed", e);
  }
}

async function botPoll(db, body) {
  const limit = Math.min(Math.max(Number(body?.limit) || 5, 1), 10);
  await touchHeartbeat(db);

  // Зависшие taken (бот упал посреди обработки) — обратно в очередь, добиваем по попыткам
  await db.prepare(
    "UPDATE gen_jobs SET status = 'queued', taken_at = NULL, attempts = attempts + 1 " +
    "WHERE status = 'taken' AND taken_at < datetime('now', ?)",
  ).bind(`-${STALE_TAKEN_MINUTES} minutes`).run();
  await db.prepare(
    "UPDATE gen_jobs SET status = 'error', error = 'internal', done_at = datetime('now') " +
    "WHERE status = 'queued' AND attempts >= ?",
  ).bind(MAX_JOB_ATTEMPTS).run();

  // Атомарное взятие: D1 сериализует записи, гонок между ботами нет
  const taken = (await db.prepare(
    "UPDATE gen_jobs SET status = 'taken', taken_at = datetime('now') WHERE id IN (" +
    "  SELECT id FROM gen_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?" +
    ") RETURNING id, user_id, username, payload",
  ).bind(limit).all()).results || [];

  return json({ ok: true, jobs: taken });
}

async function botComplete(db, body) {
  const jobId = String(body?.job_id || "");
  const status = body?.status === "done" ? "done" : "error";
  const error = String(body?.error || "");
  const result = typeof body?.result === "object" && body.result ? body.result : {};

  const job = await db.prepare("SELECT status FROM gen_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return json({ ok: true, note: "job_not_found" }); // идемпотентно
  if (job.status === "done" || job.status === "error") {
    return json({ ok: true, note: "already_completed" }); // повторный complete — no-op
  }
  await db.prepare(
    "UPDATE gen_jobs SET status = ?, error = ?, result = ?, done_at = datetime('now') WHERE id = ?",
  ).bind(status, error, JSON.stringify(result), jobId).run();
  return json({ ok: true });
}

// ── Роутер ──────────────────────────────────────────────────────

const BOT_ACTIONS = {
  "poll": (ctx) => botPoll(ctx.db, ctx.body),
  "complete": (ctx) => botComplete(ctx.db, ctx.body),
};

const WEBAPP_ACTIONS = {
  "submit": (ctx) => submit(ctx.db, ctx.user, ctx.body),
  "status": (ctx) => status(ctx.db, ctx.user, ctx.body),
};

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return json({ ok: false, error: "d1_not_bound" }, 500);

  const action = (Array.isArray(params.action) ? params.action : [params.action])
    .filter(Boolean).join("/");
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "invalid_json" }, 400);

  if (BOT_ACTIONS[action]) {
    if (!checkBotSecret(request, env)) return json({ ok: false, error: "forbidden" }, 403);
    return BOT_ACTIONS[action]({ db, body });
  }

  // Без личности: просто «работает ли схема сейчас» (кнопка выбирает подпись)
  if (action === "ready") return ready(db);

  if (WEBAPP_ACTIONS[action]) {
    if (!env.BOT_TOKEN) return json({ ok: false, error: "server_misconfigured" }, 500);
    const verified = await verifyStudioUser(body?.init_data, env.BOT_TOKEN);
    if (!verified.ok) {
      console.error(`gen auth failed: action=${action} reason=${verified.reason}`);
      return json({ ok: false, error: "invalid_init_data", debug_reason: verified.reason }, 401);
    }
    return WEBAPP_ACTIONS[action]({ db, body, user: verified });
  }

  return json({ ok: false, error: "unknown_action" }, 404);
}

export async function onRequestGet() {
  return json({ ok: false, error: "method_not_allowed" }, 405);
}
