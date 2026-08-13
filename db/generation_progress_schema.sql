-- Живой прогресс генерации (D1-зеркало), НЕ очередь заданий (в отличие от
-- studio_*). ТЗ: docs/specs/2026-08-13_webapp_generation_hub_full.md (репо
-- бота), раздел «Архитектурное решение №1». Бот сам исполняет генерацию как
-- сегодня (поллинг EvoLink/Zveno), только ДОПОЛНИТЕЛЬНО пишет статус сюда,
-- пока юзер может смотреть его в вебаппе через инлайн-кнопку «👀 Смотреть
-- прогресс». Fire-and-forget со стороны бота — недоставленная запись НЕ
-- блокирует и НЕ проваливает саму генерацию (gen_progress_create/update/
-- complete в SirNike.py).
--
-- Развёртывание (делает Аня, тот же D1-байндинг DB, что у studio_schema.sql —
-- одна база на оба набора таблиц, разные неймспейсы имён):
--   1. wrangler d1 execute sirnike-studio --remote --file=db/generation_progress_schema.sql
--   2. Секрет Pages: GEN_PROGRESS_SECRET (тот же в BotHost, переменная
--      GEN_PROGRESS_SECRET) — заголовок X-Gen-Progress-Secret для
--      progress.create/.update/.complete. progress.get авторизуется initData
--      (переиспользует verifyStudioUser/BOT_TOKEN — уже заведён).

CREATE TABLE IF NOT EXISTS generation_progress (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product TEXT NOT NULL,            -- video | midjourney | avatar (расширяемо)
  status TEXT NOT NULL DEFAULT 'processing',  -- processing | done | error
  stage TEXT NOT NULL DEFAULT 'Готовим…',     -- человекочитаемый текст стадии, бот решает
  progress_pct INTEGER NOT NULL DEFAULT 0,    -- сознательно не считаем реальный % (см. спеку) — всегда 0, поле про запас
  meta TEXT NOT NULL DEFAULT '{}',            -- JSON: модель/формат/длительность и т.п., для информационной строки
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_progress_user ON generation_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_generation_progress_updated ON generation_progress(updated_at);
