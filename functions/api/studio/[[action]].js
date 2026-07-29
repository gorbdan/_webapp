// Студия нейромультиков — все эндпоинты /api/studio/* (catch-all роутер).
// ТЗ: docs/specs/2026-07-20_cartoon_studio.md в репо бота.
//
// Два круга доступа:
//  - вебапп: POST JSON {init_data, ...} — HMAC-проверка initData (BOT_TOKEN),
//    user_id только из проверенного initData;
//  - бот:    заголовок X-Studio-Secret (STUDIO_POLL_SECRET) — poll/complete/
//    prices.push. У бота нет HTTP-входа, он сам поллит эту очередь.

import {
  json, verifyStudioUser, checkBotSecret, uuid, nowIso,
  getOwnedProject, getConfig, setConfig,
} from "./_lib.js";

const SCENE_DEFAULT_MODEL = "seedance2_fast";
const JOB_TYPES = new Set(["scenario", "frame", "clip", "stitch"]);
// Джоб «завис в taken» дольше этого — возвращаем в очередь (ревизия п.1;
// клип легально генерится до ~25 мин, порог с запасом).
const STALE_TAKEN_MINUTES = 40;
const MAX_JOB_ATTEMPTS = 3;

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function maxScenes(db) {
  const prices = await getConfig(db, "prices");
  const n = Number(prices?.max_scenes);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

async function projectView(db, project) {
  const scenes = (await db
    .prepare("SELECT * FROM studio_scenes WHERE project_id = ? ORDER BY ord")
    .bind(project.id).all()).results || [];
  const jobs = (await db
    .prepare("SELECT id, scene_id, type, status, error, created_at FROM studio_jobs WHERE project_id = ? AND status IN ('queued','taken')")
    .bind(project.id).all()).results || [];
  return { project, scenes, active_jobs: jobs };
}

// ── Действия вебаппа ────────────────────────────────────────────

async function projectList(db, userId) {
  const rows = (await db
    .prepare("SELECT id, title, status, aspect, final_url, updated_at FROM studio_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50")
    .bind(userId).all()).results || [];
  return json({ ok: true, projects: rows });
}

async function projectCreate(db, userId, body) {
  const mode = body?.mode === "manual" ? "manual" : "ai";
  const aspect = body?.aspect === "16:9" ? "16:9" : "9:16";
  const id = uuid();
  const now = nowIso();
  const refUrls = Array.isArray(body?.ref_urls) ? body.ref_urls.slice(0, 4) : [];
  await db.prepare(
    "INSERT INTO studio_projects (id, user_id, title, idea, mode, aspect, use_avatar, ref_urls, status, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
  ).bind(
    id, userId,
    String(body?.title || "").slice(0, 100),
    String(body?.idea || "").slice(0, 2000),
    mode, aspect,
    body?.use_avatar ? 1 : 0,
    JSON.stringify(refUrls),
    now, now,
  ).run();
  const project = await getOwnedProject(db, id, userId);
  return json({ ok: true, ...(await projectView(db, project)) });
}

async function projectGet(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  return json({ ok: true, ...(await projectView(db, project)) });
}

async function projectUpdate(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  const patch = body?.patch || {};
  // aspect после создания не меняется (склейка), mode тоже — только контент
  const title = "title" in patch ? String(patch.title || "").slice(0, 100) : project.title;
  const idea = "idea" in patch ? String(patch.idea || "").slice(0, 2000) : project.idea;
  const useAvatar = "use_avatar" in patch ? (patch.use_avatar ? 1 : 0) : project.use_avatar;
  const refUrls = "ref_urls" in patch && Array.isArray(patch.ref_urls)
    ? JSON.stringify(patch.ref_urls.slice(0, 4))
    : project.ref_urls;
  await db.prepare(
    "UPDATE studio_projects SET title = ?, idea = ?, use_avatar = ?, ref_urls = ?, updated_at = ? WHERE id = ?",
  ).bind(title, idea, useAvatar, refUrls, nowIso(), project.id).run();
  return json({ ok: true });
}

async function projectDelete(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  // Джобы не трогаем: бот доделает и его complete по удалённому проекту
  // станет no-op (ревизия п.9). Деньги за начатое не возвращаются — юзер
  // сам удалил проект во время генерации.
  await db.prepare("DELETE FROM studio_scenes WHERE project_id = ?").bind(project.id).run();
  await db.prepare("DELETE FROM studio_projects WHERE id = ?").bind(project.id).run();
  return json({ ok: true });
}

async function sceneUpsert(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  const s = body?.scene || {};
  const limit = await maxScenes(db);

  if (s.id) {
    const existing = await db
      .prepare("SELECT * FROM studio_scenes WHERE id = ? AND project_id = ?")
      .bind(String(s.id), project.id).first();
    if (!existing) return json({ ok: false, error: "not_found" }, 404);
    await db.prepare(
      "UPDATE studio_scenes SET ord = ?, frame_prompt = ?, video_prompt = ?, model = ?, duration = ? WHERE id = ?",
    ).bind(
      Number.isInteger(s.ord) ? s.ord : existing.ord,
      "frame_prompt" in s ? String(s.frame_prompt || "").slice(0, 2000) : existing.frame_prompt,
      "video_prompt" in s ? String(s.video_prompt || "").slice(0, 2000) : existing.video_prompt,
      "model" in s ? String(s.model || SCENE_DEFAULT_MODEL) : existing.model,
      "duration" in s ? Number(s.duration) || existing.duration : existing.duration,
      existing.id,
    ).run();
    return json({ ok: true, scene_id: existing.id });
  }

  const cnt = await db
    .prepare("SELECT COUNT(*) AS n FROM studio_scenes WHERE project_id = ?")
    .bind(project.id).first();
  if ((cnt?.n || 0) >= limit) {
    return json({ ok: false, error: "scene_limit", limit }, 400);
  }
  const id = uuid();
  await db.prepare(
    "INSERT INTO studio_scenes (id, project_id, ord, frame_prompt, video_prompt, model, duration, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'empty')",
  ).bind(
    id, project.id,
    Number.isInteger(s.ord) ? s.ord : (cnt?.n || 0),
    String(s.frame_prompt || "").slice(0, 2000),
    String(s.video_prompt || "").slice(0, 2000),
    String(s.model || SCENE_DEFAULT_MODEL),
    Number(s.duration) || 5,
  ).run();
  return json({ ok: true, scene_id: id });
}

async function sceneDelete(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  await db.prepare("DELETE FROM studio_scenes WHERE id = ? AND project_id = ?")
    .bind(String(body?.scene_id || ""), project.id).run();
  return json({ ok: true });
}

async function enqueue(db, userId, body) {
  const project = await getOwnedProject(db, body?.project_id, userId);
  if (!project) return json({ ok: false, error: "not_found" }, 404);
  const requested = Array.isArray(body?.jobs) ? body.jobs : [];
  if (!requested.length || requested.length > 20) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const scenes = (await db
    .prepare("SELECT * FROM studio_scenes WHERE project_id = ?")
    .bind(project.id).all()).results || [];
  const sceneById = Object.fromEntries(scenes.map((s) => [s.id, s]));

  // Дедуп (ревизия п.4): по сцене не может висеть два живых job'а одного типа
  const live = (await db
    .prepare("SELECT scene_id, type FROM studio_jobs WHERE project_id = ? AND status IN ('queued','taken')")
    .bind(project.id).all()).results || [];
  const liveKeys = new Set(live.map((j) => `${j.type}:${j.scene_id || ""}`));

  const created = [];
  const stmts = [];
  const frameJobBySceneId = {};
  const now = nowIso();

  for (const item of requested) {
    const type = String(item?.type || "");
    if (!JOB_TYPES.has(type)) return json({ ok: false, error: "bad_job_type" }, 400);
    const sceneId = item?.scene_id ? String(item.scene_id) : null;
    if ((type === "frame" || type === "clip") && !sceneById[sceneId]) {
      return json({ ok: false, error: "scene_not_found" }, 400);
    }
    if (liveKeys.has(`${type}:${sceneId || ""}`)) continue; // дубль — молча пропускаем
    liveKeys.add(`${type}:${sceneId || ""}`);

    const payload = typeof item?.payload === "object" && item.payload ? { ...item.payload } : {};
    payload.aspect = project.aspect;
    if (type === "frame") {
      payload.use_avatar = !!project.use_avatar;
      try { payload.ref_urls = JSON.parse(project.ref_urls || "[]"); } catch { payload.ref_urls = []; }
      if (!payload.frame_prompt) payload.frame_prompt = sceneById[sceneId].frame_prompt;
    }
    if (type === "clip") {
      const scene = sceneById[sceneId];
      if (!payload.video_prompt) payload.video_prompt = scene.video_prompt;
      if (!payload.model) payload.model = scene.model;
      if (!payload.duration) payload.duration = scene.duration;
      // depends_on (ревизия п.3): кадр ещё не готов — клип ждёт job кадра
      // из ЭТОГО же батча; кадра нет вообще — отказ.
      if (scene.frame_url) {
        payload.frame_url = scene.frame_url;
      } else if (frameJobBySceneId[sceneId]) {
        // frame_url доложит complete кадра (json_set по depends_on)
      } else {
        return json({ ok: false, error: "clip_without_frame", scene_id: sceneId }, 400);
      }
    }
    if (type === "scenario") {
      payload.idea = String(payload.idea || project.idea || "");
      if (!payload.idea.trim()) return json({ ok: false, error: "empty_idea" }, 400);
      payload.max_scenes = await maxScenes(db);
    }
    if (type === "stitch") {
      const ready = scenes.filter((s) => s.status === "clip_ready" && s.clip_url);
      if (ready.length < 2) return json({ ok: false, error: "need_two_clips" }, 400);
      payload.clips = scenes
        .filter((s) => s.status === "clip_ready" && s.clip_url)
        .sort((a, b) => a.ord - b.ord)
        .map((s) => s.clip_url);
    }

    const jobId = uuid();
    const dependsOn = type === "clip" && !payload.frame_url ? frameJobBySceneId[sceneId] : null;
    if (type === "frame") frameJobBySceneId[sceneId] = jobId;

    stmts.push(db.prepare(
      "INSERT INTO studio_jobs (id, user_id, project_id, scene_id, type, payload, depends_on, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    ).bind(jobId, userId, project.id, sceneId, type, JSON.stringify(payload), dependsOn, now));

    if (type === "frame" && sceneId) {
      stmts.push(db.prepare("UPDATE studio_scenes SET status = 'frame_queued', error = '' WHERE id = ?").bind(sceneId));
    }
    if (type === "clip" && sceneId) {
      stmts.push(db.prepare("UPDATE studio_scenes SET status = 'clip_queued', error = '' WHERE id = ?").bind(sceneId));
    }
    if (type === "stitch") {
      stmts.push(db.prepare("UPDATE studio_projects SET status = 'stitching', updated_at = ? WHERE id = ?").bind(now, project.id));
    }
    created.push({ id: jobId, type, scene_id: sceneId });
  }

  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, jobs: created });
}

async function pricesGet(db) {
  const prices = await getConfig(db, "prices");
  if (!prices) return json({ ok: false, error: "prices_not_ready" }, 503);
  return json({ ok: true, prices });
}

// Загрузка референс-фото юзера: ключ imgbb нельзя светить в браузере
// (ревизия п.6) — заливает Function. Клиент шлёт уже ужатый JPEG base64.
async function uploadRef(env, body) {
  const b64 = String(body?.image_base64 || "");
  if (!b64 || b64.length > 2_500_000) return json({ ok: false, error: "bad_image" }, 400);
  if (!env.IMGBB_API_KEY) return json({ ok: false, error: "server_misconfigured" }, 500);
  const form = new FormData();
  form.append("image", b64);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${env.IMGBB_API_KEY}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  const url = data?.data?.url;
  if (!res.ok || !url) return json({ ok: false, error: "upload_failed" }, 502);
  return json({ ok: true, url });
}

// ── Действия бота (X-Studio-Secret) ─────────────────────────────

async function botPoll(db, body) {
  const limit = Math.min(Math.max(Number(body?.limit) || 5, 1), 10);

  // Ревизия п.1: возвращаем зависшие taken в очередь, добиваем по попыткам
  await db.prepare(
    "UPDATE studio_jobs SET status = 'queued', taken_at = NULL, attempts = attempts + 1 " +
    "WHERE status = 'taken' AND taken_at < datetime('now', ?)",
  ).bind(`-${STALE_TAKEN_MINUTES} minutes`).run();
  await db.prepare(
    "UPDATE studio_jobs SET status = 'error', error = 'internal', done_at = datetime('now') " +
    "WHERE status = 'queued' AND attempts >= ?",
  ).bind(MAX_JOB_ATTEMPTS).run();
  // Каскад по зависимостям: родитель упал — потомку нет смысла ждать
  await db.prepare(
    "UPDATE studio_jobs SET status = 'error', error = 'dependency_failed', done_at = datetime('now') " +
    "WHERE status = 'queued' AND depends_on IN (SELECT id FROM studio_jobs WHERE status = 'error')",
  ).run();

  // Атомарное взятие: D1 сериализует записи, гонок между ботами нет
  const taken = (await db.prepare(
    "UPDATE studio_jobs SET status = 'taken', taken_at = datetime('now') WHERE id IN (" +
    "  SELECT id FROM studio_jobs WHERE status = 'queued' AND (" +
    "    depends_on IS NULL OR depends_on IN (SELECT id FROM studio_jobs WHERE status = 'done')" +
    "  ) ORDER BY created_at LIMIT ?" +
    ") RETURNING id, user_id, project_id, scene_id, type, payload",
  ).bind(limit).all()).results || [];

  return json({ ok: true, jobs: taken });
}

async function botComplete(db, body) {
  const jobId = String(body?.job_id || "");
  const status = body?.status === "done" ? "done" : "error";
  const error = String(body?.error || "");
  const result = typeof body?.result === "object" && body.result ? body.result : {};

  const job = await db.prepare("SELECT * FROM studio_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return json({ ok: true, note: "job_not_found" }); // идемпотентно
  if (job.status === "done" || job.status === "error") {
    return json({ ok: true, note: "already_completed" }); // повторный complete — no-op
  }

  const now = nowIso();
  const stmts = [
    db.prepare("UPDATE studio_jobs SET status = ?, error = ?, result = ?, done_at = ? WHERE id = ?")
      .bind(status, error, JSON.stringify(result), now, jobId),
  ];

  const project = await db.prepare("SELECT * FROM studio_projects WHERE id = ?").bind(job.project_id).first();
  // Проект удалён во время генерации — просто закрываем job (ревизия п.9)
  if (project) {
    if (job.type === "scenario" && status === "done" && Array.isArray(result.scenes)) {
      const limit = await maxScenes(db);
      const existing = await db.prepare("SELECT COUNT(*) AS n FROM studio_scenes WHERE project_id = ?").bind(job.project_id).first();
      let ord = existing?.n || 0;
      for (const scene of result.scenes.slice(0, Math.max(0, limit - ord))) {
        stmts.push(db.prepare(
          "INSERT INTO studio_scenes (id, project_id, ord, frame_prompt, video_prompt, model, duration, status) VALUES (?, ?, ?, ?, ?, ?, 5, 'empty')",
        ).bind(uuid(), job.project_id, ord, String(scene.frame_prompt || "").slice(0, 2000), String(scene.video_prompt || "").slice(0, 2000), SCENE_DEFAULT_MODEL));
        ord += 1;
      }
    }
    if (job.type === "frame" && job.scene_id) {
      if (status === "done" && result.frame_url) {
        const scene = await db.prepare("SELECT clip_url FROM studio_scenes WHERE id = ?").bind(job.scene_id).first();
        stmts.push(db.prepare(
          "UPDATE studio_scenes SET frame_url = ?, status = 'frame_ready', error = '', frame_newer_than_clip = ? WHERE id = ?",
        ).bind(String(result.frame_url), scene?.clip_url ? 1 : 0, job.scene_id));
        // Ждущим клипам этой цепочки докладываем frame_url (ревизия п.3)
        stmts.push(db.prepare(
          "UPDATE studio_jobs SET payload = json_set(payload, '$.frame_url', ?) WHERE depends_on = ? AND status = 'queued'",
        ).bind(String(result.frame_url), jobId));
      } else {
        stmts.push(db.prepare("UPDATE studio_scenes SET status = 'error', error = ? WHERE id = ?").bind(error || "internal", job.scene_id));
      }
    }
    if (job.type === "clip" && job.scene_id) {
      if (status === "done" && result.clip_url) {
        stmts.push(db.prepare(
          "UPDATE studio_scenes SET clip_url = ?, status = 'clip_ready', error = '', frame_newer_than_clip = 0, duration = ? WHERE id = ?",
        ).bind(String(result.clip_url), Number(result.duration) || 5, job.scene_id));
      } else {
        stmts.push(db.prepare("UPDATE studio_scenes SET status = 'error', error = ? WHERE id = ?").bind(error || "internal", job.scene_id));
      }
    }
    if (job.type === "stitch") {
      if (status === "done" && result.final_url) {
        stmts.push(db.prepare("UPDATE studio_projects SET status = 'done', final_url = ?, updated_at = ? WHERE id = ?").bind(String(result.final_url), now, job.project_id));
      } else {
        stmts.push(db.prepare("UPDATE studio_projects SET status = 'draft', updated_at = ? WHERE id = ?").bind(now, job.project_id));
      }
    }
    stmts.push(db.prepare("UPDATE studio_projects SET updated_at = ? WHERE id = ?").bind(now, job.project_id));
  }

  await db.batch(stmts);
  return json({ ok: true });
}

// ── Роутер ──────────────────────────────────────────────────────

const WEBAPP_ACTIONS = {
  "project.list": (ctx) => projectList(ctx.db, ctx.userId),
  "project.create": (ctx) => projectCreate(ctx.db, ctx.userId, ctx.body),
  "project.get": (ctx) => projectGet(ctx.db, ctx.userId, ctx.body),
  "project.update": (ctx) => projectUpdate(ctx.db, ctx.userId, ctx.body),
  "project.delete": (ctx) => projectDelete(ctx.db, ctx.userId, ctx.body),
  "scene.upsert": (ctx) => sceneUpsert(ctx.db, ctx.userId, ctx.body),
  "scene.delete": (ctx) => sceneDelete(ctx.db, ctx.userId, ctx.body),
  "enqueue": (ctx) => enqueue(ctx.db, ctx.userId, ctx.body),
  "prices.get": (ctx) => pricesGet(ctx.db),
  "upload": (ctx) => uploadRef(ctx.env, ctx.body),
};

const BOT_ACTIONS = {
  "poll": (ctx) => botPoll(ctx.db, ctx.body),
  "complete": (ctx) => botComplete(ctx.db, ctx.body),
  "prices.push": async (ctx) => {
    if (typeof ctx.body?.prices !== "object" || !ctx.body.prices) {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    await setConfig(ctx.db, "prices", ctx.body.prices);
    return json({ ok: true });
  },
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
    return BOT_ACTIONS[action]({ db, env, body });
  }

  if (WEBAPP_ACTIONS[action]) {
    if (!env.BOT_TOKEN) return json({ ok: false, error: "server_misconfigured" }, 500);
    const verified = await verifyStudioUser(body?.init_data, env.BOT_TOKEN);
    if (!verified.ok) {
      // Живой баг 2026-07-28: логируем ПРИЧИНУ отказа для диагностики
      // (Cloudflare Observability → Logs) — "сессия устарела" на клиенте
      // раньше маскировала все варианты (no_hash/hash_mismatch/
      // stale_auth_date/empty_init_data/...) под одним сообщением.
      console.error(`studio auth failed: action=${action} reason=${verified.reason}`);
      return json({ ok: false, error: "invalid_init_data" }, 401);
    }
    return WEBAPP_ACTIONS[action]({ db, env, body, userId: verified.userId });
  }

  return json({ ok: false, error: "unknown_action" }, 404);
}

export async function onRequestGet() {
  return json({ ok: false, error: "method_not_allowed" }, 405);
}
