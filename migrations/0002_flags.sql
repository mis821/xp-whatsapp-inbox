-- "Zaroori": messages that matter — the office number tagged in a group, "Neeraj" named, or
-- payment asked for. A flag stays open until ticked off on the dashboard, whatever happens on
-- WhatsApp (read, replied, archived): the point is the evening list, not the unread badge.
CREATE TABLE IF NOT EXISTS flags (
  msg_id   TEXT PRIMARY KEY,      -- messages.id
  chat     TEXT NOT NULL,
  t        INTEGER NOT NULL,      -- message time, ms
  reasons  TEXT NOT NULL,         -- space-separated: tag neeraj payment
  done_at  INTEGER                -- NULL = still to do
);
CREATE INDEX IF NOT EXISTS idx_flags_open ON flags (done_at, t);
