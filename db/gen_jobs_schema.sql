-- Очередь генераций из вебаппа («Всё в вебаппе»): вебапп кладёт задание
-- (submit), бот забирает поллингом (poll) и отчитывается (complete).
-- ТЗ: docs/specs/2026-11-16_webapp_gen_transport.md (репо бота).
-- Та же D1-база (байндинг DB), что у studio_* и generation_progress.
--
-- Применить (делает Аня, один раз):
--   wrangler d1 execute sirnike-studio --remote --file=db/gen_jobs_schema.sql
-- Секреты не нужны новые: используются BOT_TOKEN и STUDIO_POLL_SECRET.

CREATE TABLE IF NOT EXISTS gen_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,                 -- JSON-строка, тот же payload, что шёл в tg.sendData
  payload_hash TEXT NOT NULL DEFAULT '', -- для дедупа двойного тапа
  status TEXT NOT NULL DEFAULT 'queued', -- queued | taken | done | error
  error TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}',     -- JSON от бота: accepted/launched/progress_id/messages
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  taken_at TEXT,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gen_jobs_status ON gen_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_gen_jobs_user ON gen_jobs(user_id, created_at);
