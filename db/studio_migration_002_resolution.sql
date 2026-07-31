-- Студия нейромультиков — миграция 002: качество (resolution) для клипов + 4:3.
-- Схема в studio_schema.sql уже обновлена для новых установок; на уже
-- развёрнутой D1 (sirnike-studio) нужно применить ЭТОТ файл один раз:
--   wrangler d1 execute sirnike-studio --remote --file=db/studio_migration_002_resolution.sql
-- 4:3 для studio_projects.aspect новой колонки не требует — это TEXT без
-- CHECK-ограничения, валидация только в коде Function (enqueue/projectCreate).

ALTER TABLE studio_scenes ADD COLUMN resolution TEXT DEFAULT '720p';
