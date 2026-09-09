-- Kaizen Raid Manager - D1 schema (end state, idempotent - safe to run
-- against a fresh database or one that already matches this shape).
--
-- Step 1 (already live) made this a real database instead of
-- kaizen_data.json-on-GitHub - one singleton app_state row, real
-- optimistic concurrency, real auth. This step makes it multi-tenant: a
-- guild is now a real row, not an assumption baked into the whole app.
-- Still NOT normalizing roster/strats/raids/etc into their own tables -
-- app_state stays one JSON blob (same shape buildSavePayload() already
-- produces), just one blob PER GUILD now instead of one total. Going all
-- the way to per-entity tables is real, but it's an optimization for
-- later (once row-level granularity or cross-guild queries actually need
-- it), not a prerequisite for "more than one guild can use this."
--
-- Migrating an existing pre-multi-tenant database (a singleton app_state
-- with no guilds table at all) needs migrate-to-multitenant.sql run ONCE
-- first - it's not idempotent and isn't meant to be re-run, unlike this
-- file. A fresh database can skip straight to this file.

CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,       -- URL-safe, e.g. "kaizen"
  name TEXT NOT NULL,              -- display name, e.g. "Kaizen"
  discord_guild_id TEXT,           -- the real Discord server this guild is tied to, once verified
  owner_user_id TEXT,              -- Clerk user id of whoever registered/owns it
  created_at TEXT NOT NULL
);

-- Who belongs to which guild, with what role and approval status - the
-- actual access-control boundary (see verifyGuildAccess in
-- kaizen-worker.js). role/status are plain strings, not enums (D1/SQLite
-- has none) - kept to 'gm' | 'officer' | 'raider' and
-- 'pending' | 'active' | 'rejected' by application-code convention, not
-- a DB constraint.
CREATE TABLE IF NOT EXISTS guild_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  user_id TEXT NOT NULL,           -- Clerk user id
  role TEXT NOT NULL DEFAULT 'raider',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,                 -- Clerk user id of whoever approved/rejected
  UNIQUE(guild_id, user_id)
);

-- One row per guild now, not a singleton - see migrate-to-multitenant.sql
-- for how an existing single-guild database's one row becomes guild_id 1.
CREATE TABLE IF NOT EXISTS app_state (
  guild_id INTEGER PRIMARY KEY REFERENCES guilds(id),
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
