-- ONE-TIME migration from the single-guild schema (a singleton app_state
-- row, no guilds table) to the multi-tenant one in schema.sql. Run once
-- against a database that still has the old shape; NOT safe to re-run
-- (it will error the second time, harmlessly, since app_state will
-- already be in the new shape by then - see the plain CREATE TABLE IF
-- NOT EXISTS versions in schema.sql for the idempotent end state).
CREATE TABLE guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  discord_guild_id TEXT,
  owner_user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE guild_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'raider',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE(guild_id, user_id)
);

-- The existing pilot's one and only guild - everything currently in
-- app_state belongs to this.
INSERT INTO guilds (id, slug, name, created_at) VALUES (1, 'kaizen', 'Kaizen', datetime('now'));

-- Move the existing singleton app_state row (id=1) to the new
-- guild-scoped shape (guild_id=1), preserving its data/version/
-- updated_at/updated_by exactly.
CREATE TABLE app_state_new (
  guild_id INTEGER PRIMARY KEY REFERENCES guilds(id),
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
INSERT INTO app_state_new (guild_id, data, version, updated_at, updated_by)
  SELECT 1, data, version, updated_at, updated_by FROM app_state WHERE id = 1;
DROP TABLE app_state;
ALTER TABLE app_state_new RENAME TO app_state;
