// Живой прогресс генерации (D1-зеркало) — /api/progress/*. ТЗ:
// docs/specs/2026-08-13_webapp_generation_hub_full.md (репо бота), раздел
// «Архитектурное решение №1/№2». НЕ очередь заданий (в отличие от
// /api/studio/*) — write-only зеркало статуса: бот сам исполняет генерацию,
// только пишет сюда прогресс. Два круга доступа, тот же паттерн, что уже
// проверен на /api/studio/[[action]].js (переиспользуем verifyStudioUser —
// это чистая Telegram-initData-HMAC-проверка, не завязана на студию, только
// имя функции унаследовано от первого места, где она появилась):
//  - бот: заголовок X-Gen-Progress-Secret (GEN_PROGRESS_SECRET) —
//    progress.create/.update/.complete;
//  - вебапп: POST {init_data, job_id} — progress.get, 403 при несовпадении
//    user_id из initData с user_id строки (юзер не должен видеть чужой
//    прогресс по угаданному/скопированному job_id).

import { json, verifyStudioUser, nowIso, uuid as _uuid } from "../studio/_lib.js";

const STATUSES = new Set(["processing", "done", "error"]);
// Строки старше этого — считаем мусором и подчищаем лениво (без Cron
// Triggers, см. docstring cleanupStale ниже).
const STALE_MS = 24 * 60 * 60 * 1000;

function checkGenProgressSecret(request, env) {
  const secret = String(env.GEN_PROGRESS_SECRET || "");
  if (!secret) return false;
  const got = request.headers.get("X-Gen-Progress-Secret") || "";
  return got === secret;
}

// Housekeeping без настоящего Cron Trigger: Cloudflare Pages Functions
// (директория functions/, не отдельный _worker.js) на момент написания не
// даёт чистого способа повесить scheduled()-хендлер рядом с обычными HTTP-
// функциями в этом же проекте — заводить отдельный Worker только ради
// удаления старых строк несоразмерно задаче. Вместо этого чистим лениво на
// каждом progress.create (самый частый вызов — новый прогресс создаётся при
// каждом старте генерации, то есть чистка происходит часто и без отдельной
// инфраструктуры). Если Аня решит завести настоящий Cron Trigger отдельным
// Worker'ом позже — этот вызов можно оставить как есть, он идемпотентен и
// дешёв (один DELETE по индексу updated_at).
async function cleanupStale(db) {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  try {
    await db.prepare("DELETE FROM generation_progress WHERE updated_at < ?").bind(cutoff).run();
  } catch (e) {
    console.error("gen_progress cleanup failed", e);
  }
}

async function progressCreate(db, body) {
  const id = String(body?.id || "").trim() || _uuid();
  const userId = Number(body?.user_id);
  const product = String(body?.product || "").trim();
  if (!Number.isInteger(userId) || userId <= 0 || !product) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};
  const now = nowIso();
  await cleanupStale(db);
  await db.prepare(
    "INSERT INTO generation_progress (id, user_id, product, status, stage, progress_pct, meta, created_at, updated_at) " +
    "VALUES (?, ?, ?, 'processing', 'Готовим…', 0, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, product = excluded.product, " +
    "meta = excluded.meta, updated_at = excluded.updated_at",
  ).bind(id, userId, product, JSON.stringify(meta), now, now).run();
  return json({ ok: true, id });
}

async function progressUpdate(db, body) {
  const id = String(body?.id || "").trim();
  if (!id) return json({ ok: false, error: "bad_request" }, 400);
  const status = STATUSES.has(body?.status) ? body.status : "processing";
  const stage = String(body?.stage || "").slice(0, 200) || "Генерируем…";
  const pct = Number.isFinite(Number(body?.progress_pct)) ? Math.max(0, Math.min(100, Math.round(Number(body.progress_pct)))) : 0;
  const res = await db.prepare(
    "UPDATE generation_progress SET status = ?, stage = ?, progress_pct = ?, updated_at = ? WHERE id = ?",
  ).bind(status, stage, pct, nowIso(), id).run();
  if (!res?.meta?.changes) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true });
}

async function progressComplete(db, body) {
  const id = String(body?.id || "").trim();
  if (!id) return json({ ok: false, error: "bad_request" }, 400);
  const status = body?.status === "error" ? "error" : "done";
  const stage = String(body?.stage || "").slice(0, 200) || (status === "error" ? "Не получилось" : "Готово!");
  const res = await db.prepare(
    "UPDATE generation_progress SET status = ?, stage = ?, progress_pct = ?, updated_at = ? WHERE id = ?",
  ).bind(status, stage, status === "done" ? 100 : 0, nowIso(), id).run();
  if (!res?.meta?.changes) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true });
}

async function progressGet(db, userId, body) {
  const id = String(body?.job_id || body?.id || "").trim();
  if (!id) return json({ ok: false, error: "bad_request" }, 400);
  const row = await db.prepare("SELECT * FROM generation_progress WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);
  // Юзер физически не может увидеть чужой прогресс, даже зная/угадав id —
  // ровно та же проверка владения, что getOwnedProject у Студии.
  if (Number(row.user_id) !== userId) return json({ ok: false, error: "forbidden" }, 403);
  let meta = {};
  try { meta = JSON.parse(row.meta || "{}"); } catch { meta = {}; }
  return json({
    ok: true,
    status: row.status,
    stage: row.stage,
    product: row.product,
    progress_pct: row.progress_pct,
    meta,
    updated_at: row.updated_at,
  });
}

const BOT_ACTIONS = {
  "progress.create": (ctx) => progressCreate(ctx.db, ctx.body),
  "progress.update": (ctx) => progressUpdate(ctx.db, ctx.body),
  "progress.complete": (ctx) => progressComplete(ctx.db, ctx.body),
};

const WEBAPP_ACTIONS = {
  "progress.get": (ctx) => progressGet(ctx.db, ctx.userId, ctx.body),
};

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return json({ ok: false, error: "d1_not_bound" }, 500);

  const action = (Array.isArray(params.action) ? params.action : [params.action])
    .filter(Boolean).join("/");
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "invalid_json" }, 400);

  if (BOT_ACTIONS[action]) {
    if (!checkGenProgressSecret(request, env)) return json({ ok: false, error: "forbidden" }, 403);
    return BOT_ACTIONS[action]({ db, env, body });
  }

  if (WEBAPP_ACTIONS[action]) {
    if (!env.BOT_TOKEN) return json({ ok: false, error: "server_misconfigured" }, 500);
    const verified = await verifyStudioUser(body?.init_data, env.BOT_TOKEN);
    if (!verified.ok) {
      console.error(`gen_progress auth failed: action=${action} reason=${verified.reason}`);
      return json({ ok: false, error: "invalid_init_data", debug_reason: verified.reason }, 401);
    }
    return WEBAPP_ACTIONS[action]({ db, env, body, userId: verified.userId });
  }

  return json({ ok: false, error: "unknown_action" }, 404);
}

export async function onRequestGet() {
  return json({ ok: false, error: "method_not_allowed" }, 405);
}
