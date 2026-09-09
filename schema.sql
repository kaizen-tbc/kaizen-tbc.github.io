-- Kaizen Raid Helper - D1 schema, step 1 (see wrangler.toml's kaizen_db
-- binding). Replaces kaizen_data.json-committed-to-GitHub as the
-- datastore. Deliberately NOT split per-guild yet - this step is "get
-- Kaizen off GitHub-as-a-database and onto something with real
-- concurrency control and real auth," not "become multi-tenant." That's
-- planned as its own later step, done together with normalizing this
-- single blob into real relational tables (roster/strats/raids/etc each
-- get their own guild_id-scoped table) - both changes touch every read
-- and write in the ~12k-line frontend, so there's no benefit to doing
-- them twice.
--
-- app_state is intentionally a single row holding the exact same JSON
-- shape buildSavePayload() in kaizen_raid_manager.html already produces -
-- the smallest possible change that gets real infrastructure under this
-- app: one source of truth, one place access control actually applies,
-- and (via `version`) a real optimistic-concurrency check instead of
-- "whoever's git commit lands second silently overwrites the first,"
-- which is what happened more than once with the old GitHub-file setup.
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row, enforced
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
