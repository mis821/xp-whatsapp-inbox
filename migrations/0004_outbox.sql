-- Replies written on the dashboard. WhatsApp Web (the Tampermonkey script) collects pending ones
-- every few seconds and sends them as a proper quoted reply from the office number, exactly as if
-- typed there; WaSender is the fallback when that tab is closed (it cannot quote).
CREATE TABLE IF NOT EXISTS outbox (
  id         TEXT PRIMARY KEY,
  created    INTEGER NOT NULL,
  chat       TEXT NOT NULL,
  quote      TEXT,                 -- messages.id being replied to
  text       TEXT NOT NULL,
  flag_id    TEXT,                 -- Zaroori item to tick off once sent (when asked)
  mark_done  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed
  via        TEXT,                 -- web | wasender
  claimed_at INTEGER,
  sent_at    INTEGER,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, created);
