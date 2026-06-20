-- Control database: identity, tenants (organisations) and membership.
-- Each tenant's *accounting* data lives in its own SQLite file using the
-- existing Book of Business engine — this DB only governs who may open which.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- stored lower-cased
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,                 -- scrypt: salt:hash (hex)
  status        TEXT NOT NULL DEFAULT 'ACTIVE',-- ACTIVE | DISABLED
  totp_secret   TEXT,                          -- base32 TOTP secret (when 2FA set up)
  totp_enabled  INTEGER NOT NULL DEFAULT 0,    -- 1 once enrolment is confirmed
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  db_file     TEXT NOT NULL UNIQUE,            -- relative filename of this tenant's accounting DB
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A user's membership of a tenant, with the role that governs what they may do.
-- role mirrors the accounting engine's seeded roles: 'Adviser' (owner/admin),
-- 'Standard', 'Read Only', 'Invoice Only'.
CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  role       TEXT NOT NULL DEFAULT 'Standard',
  is_owner   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  email      TEXT NOT NULL,                    -- lower-cased target
  role       TEXT NOT NULL DEFAULT 'Standard',
  token      TEXT NOT NULL UNIQUE,             -- random; embedded in the invite link
  invited_by INTEGER REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACCEPTED | REVOKED
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS ix_memberships_user ON memberships(user_id);
