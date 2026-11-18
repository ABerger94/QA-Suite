-- QA Lab Suite — Turso / libSQL schema. Safe to run repeatedly.

-- People. Accounts are never deleted (deactivate instead), so a user ID is never reused.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,                 -- printed name shown on e-signatures
  role          TEXT NOT NULL CHECK (role IN ('viewer','tech','manager','admin')),
  pw_hash       TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  pw_iter       INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  must_change   INTEGER NOT NULL DEFAULT 1,
  pw_changed_at TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);

-- Sign-in sessions. Only a SHA-256 of the bearer token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- QA records (swabs, lots, loads, holds, cases, ...). One JSON document per record.
-- Deletes are soft (deleted = 1) so the record and its history stay retrievable.
CREATE TABLE IF NOT EXISTS records (
  coll       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (coll, id)
);

-- Electronic signatures (printed name, date/time, meaning), linked to the exact record content signed.
CREATE TABLE IF NOT EXISTS signatures (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id),
  user_name      TEXT NOT NULL,
  user_email     TEXT NOT NULL,
  meaning        TEXT NOT NULL,
  statement      TEXT NOT NULL,
  coll           TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  content_hash   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signatures_rec ON signatures(coll, record_id);

-- Computer-generated, time-stamped audit trail. Keeps full before/after values.
-- Each row carries a SHA-256 chained to the previous row, so any out-of-band edit is detectable.
CREATE TABLE IF NOT EXISTS audit_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  user_id   TEXT,
  user_name TEXT,
  action    TEXT NOT NULL,
  coll      TEXT,
  record_id TEXT,
  version   INTEGER,
  before    TEXT,
  after     TEXT,
  reason    TEXT,
  summary   TEXT,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_rec ON audit_log(coll, record_id);

-- Append-only: the application can never modify or remove audit entries or signatures.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS signatures_no_update BEFORE UPDATE ON signatures
BEGIN SELECT RAISE(ABORT, 'signatures are permanent'); END;
CREATE TRIGGER IF NOT EXISTS signatures_no_delete BEFORE DELETE ON signatures
BEGIN SELECT RAISE(ABORT, 'signatures are permanent'); END;
