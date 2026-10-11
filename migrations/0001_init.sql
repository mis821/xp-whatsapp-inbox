-- One row per WhatsApp message or call, as WaSender delivered it. The id is WhatsApp's own
-- message id, so a webhook delivered twice (messages.upsert + messages.received) lands once.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  received_at  INTEGER NOT NULL,          -- ms, when the webhook arrived
  t            INTEGER NOT NULL,          -- ms, when the message was sent
  event        TEXT,
  chat         TEXT NOT NULL,             -- group jid (…@g.us) or person jid
  is_group     INTEGER NOT NULL DEFAULT 0,
  from_me      INTEGER NOT NULL DEFAULT 0,
  sender       TEXT,
  sender_phone TEXT,
  sender_name  TEXT,
  type         TEXT,
  text         TEXT,
  mentions     TEXT,
  reply_to     TEXT,
  tag          INTEGER NOT NULL DEFAULT 0 -- 1 = tags / replies to / is direct to the office number
);
CREATE INDEX IF NOT EXISTS idx_messages_t ON messages (t);
CREATE INDEX IF NOT EXISTS idx_messages_chat_t ON messages (chat, t);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at);

-- One row per chat. name comes from WaSender (groups) or the contact list (people);
-- category / muted / seen state are the user's.
CREATE TABLE IF NOT EXISTS chats (
  jid        TEXT PRIMARY KEY,
  name       TEXT,
  kind       TEXT NOT NULL DEFAULT 'group',  -- group | personal
  category   TEXT,                           -- NULL = automatic (Supplier / Internal / Personal)
  muted      INTEGER NOT NULL DEFAULT 0,
  seen_upto  INTEGER NOT NULL DEFAULT 0,
  tags_upto  INTEGER NOT NULL DEFAULT 0
);

-- phone jid and LID both map to a display name.
CREATE TABLE IF NOT EXISTS contacts (
  jid  TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id        TEXT PRIMARY KEY,
  created   INTEGER NOT NULL,
  source    TEXT,
  type      TEXT,
  party     TEXT,
  kaam      TEXT NOT NULL,
  due       TEXT,                 -- yyyy-mm-dd (IST)
  team      TEXT,
  status    TEXT NOT NULL DEFAULT 'Open',  -- Open | Done | Cancelled
  done_at   INTEGER,
  chat      TEXT,
  msg_id    TEXT UNIQUE,          -- the "#kaam" message that created it (so a redelivery cannot duplicate it)
  src_msg   TEXT,                 -- the message a dashboard "+ Kaam" was made from (any number of tasks)
  message   TEXT,
  notified  TEXT,
  note      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, due);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
