-- ============================================================
-- RMA Blaster on D1: change history and flags.
-- Same as schema-phase3.sql and schema-phase4.sql in the Supabase
-- version, which the live app gained on 2026-11-16.
--
-- Supabase filled entry_history with a database trigger. Here the
-- Worker writes it, in the same transaction as the save it records
-- (worker/index.mjs, historyStatements). The app has no way to write,
-- edit or delete these rows: the API only reads them.
-- ============================================================

-- The ticked flags, comma separated, e.g. "in-store,needs-repair".
-- The list of flags lives in flags.js.
ALTER TABLE entries ADD COLUMN flags TEXT NOT NULL DEFAULT '';

CREATE TABLE entry_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL,      -- no foreign key on purpose: the log outlives the entry
  rma_number  TEXT,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id     TEXT,                  -- Access user id here; Supabase login id on copied rows
  user_email  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,         -- created | imported | edited
  field       TEXT NOT NULL,         -- column name in entries
  old_value   TEXT,
  new_value   TEXT
);

CREATE INDEX entry_history_entry_idx ON entry_history (entry_id, id DESC);
