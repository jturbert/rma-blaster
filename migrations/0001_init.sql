-- ============================================================
-- RMA Blaster on Cloudflare D1 (SQLite).
--
-- Same three tables as the Supabase version (schema.sql and
-- schema-phase2.sql), with the same column names, so the app's
-- field mapping in storage.js did not have to change.
--
-- Differences from Postgres, all handled in worker/index.mjs:
--   deleted      0/1 here, true/false in the app
--   attachments  JSON text here, an array in the app
--   timestamps   ISO text, always written as toISOString() so that
--                comparing two of them as strings sorts by time
--
-- There is no Row Level Security. Nothing can reach this database
-- except the Worker, and the Worker checks the Cloudflare Access
-- login on every request.
--
-- Apply with:  npm run db:migrate:remote   (or :local)
-- ============================================================

CREATE TABLE entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id           TEXT UNIQUE,
  rma_number         TEXT NOT NULL,
  date               TEXT,
  dealer             TEXT DEFAULT '',
  make               TEXT DEFAULT '',
  model              TEXT DEFAULT '',
  serial_number      TEXT DEFAULT '',
  issue_description  TEXT DEFAULT '',
  issue_confirmed    TEXT DEFAULT '',
  warranty_status    TEXT DEFAULT '',
  course_of_action   TEXT DEFAULT '',
  date_of_resolution TEXT DEFAULT '',
  how_resolved       TEXT DEFAULT '',
  notes              TEXT DEFAULT '',
  replaced_from      TEXT DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'Open',
  deleted            INTEGER NOT NULL DEFAULT 0,
  deleted_at         TEXT,
  imported_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_modified      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pdfs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'rma-form',   -- rma-form | invoice | photo
  storage_path TEXT NOT NULL,                      -- the key in the R2 bucket
  saved_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pending_emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT UNIQUE,
  subject       TEXT,
  from_address  TEXT,
  sent_at       TEXT,
  text_body     TEXT,
  attachments   TEXT NOT NULL DEFAULT '[]',   -- JSON: [{filename, storagePath, contentType}]
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | processed | ignored | error
  error         TEXT,
  entry_id      INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  received_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at  TEXT
);

CREATE INDEX entries_rma_idx    ON entries (rma_number);
CREATE INDEX entries_del_idx    ON entries (deleted);
CREATE INDEX pdfs_entry_idx     ON pdfs (entry_id);
CREATE INDEX pending_status_idx ON pending_emails (status);
CREATE INDEX pending_entry_idx  ON pending_emails (entry_id);
