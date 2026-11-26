-- Each document is sent to a supplier's group once only (🧾 Reconciliation → 📤 Send to group).
-- One row per document, keyed by its letters and digits in upper case, so "PRET-2627-00031" and
-- "PRET262700031" are the same document. t = when it was sent; t = 0 while a send is under way
-- (claimed at `claimed`), so two clicks or two devices cannot both send it.
CREATE TABLE IF NOT EXISTS doc_sent (
  doc       TEXT PRIMARY KEY,
  t         INTEGER NOT NULL DEFAULT 0,
  claimed   INTEGER NOT NULL DEFAULT 0,
  chat_name TEXT
);
-- Documents sent before this table existed count as sent.
INSERT OR IGNORE INTO doc_sent (doc, t, claimed, chat_name)
  SELECT UPPER(REPLACE(REPLACE(REPLACE(doc, '-', ''), '/', ''), ' ', '')), t, t, chat_name FROM doc_sends ORDER BY t;
