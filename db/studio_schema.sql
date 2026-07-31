-- Студия нейромультиков — схема D1 (очередь заданий + проекты).
-- ТЗ: docs/specs/2026-07-20_cartoon_studio.md в репо бота.
--
-- Развёртывание (делает Аня один раз):
--   1. В Cloudflare Dashboard → D1 → создать базу sirnike-studio.
--   2. Привязать к Pages-проекту: Settings → Functions → D1 bindings,
--      имя биндинга — DB.
--   3. Применить схему: wrangler d1 execute sirnike-studio --remote --file=db/studio_schema.sql
--   4. Секреты Pages: STUDIO_POLL_SECRET (тот же в BotHost), IMGBB_API_KEY
--      (тот же, что в BotHost; BOT_TOKEN уже заведён).

CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT DEFAULT '',
  idea TEXT DEFAULT '',
  mode TEXT DEFAULT 'ai',         -- ai | manual
  aspect TEXT DEFAULT '9:16',     -- 9:16 | 16:9 | 4:3, фикс после создания (склейка)
  use_avatar INTEGER DEFAULT 0,
  ref_urls TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',    -- draft | stitching | done
  final_url TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_studio_projects_user ON studio_projects(user_id);

CREATE TABLE IF NOT EXISTS studio_scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  frame_prompt TEXT DEFAULT '',
  frame_url TEXT DEFAULT '',
  video_prompt TEXT DEFAULT '',
  model TEXT DEFAULT 'seedance2_fast',
  duration INTEGER DEFAULT 5,
  resolution TEXT DEFAULT '720p',
  clip_url TEXT DEFAULT '',
  -- empty|frame_queued|frame_ready|clip_queued|clip_ready|error
  status TEXT DEFAULT 'empty',
  error TEXT DEFAULT '',
  -- кадр перегенерирован ПОСЛЕ готового клипа (ревизия п.9) — UI подсказывает
  frame_newer_than_clip INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_studio_scenes_project ON studio_scenes(project_id, ord);

CREATE TABLE IF NOT EXISTS studio_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  scene_id TEXT,
  type TEXT NOT NULL,             -- scenario | frame | clip | stitch
  payload TEXT DEFAULT '{}',
  depends_on TEXT,
  status TEXT DEFAULT 'queued',   -- queued | taken | done | error
  error TEXT DEFAULT '',
  result TEXT DEFAULT '{}',
  attempts INTEGER DEFAULT 0,
  created_at TEXT, taken_at TEXT, done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_status ON studio_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_project ON studio_jobs(project_id, status);

-- Ключ-значение: прайс-лист от бота (prices.push) и прочий конфиг
CREATE TABLE IF NOT EXISTS studio_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
