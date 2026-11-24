-- Documents sent to suppliers' WhatsApp groups from the 🧾 Reconciliation tab, one row per send.
CREATE TABLE IF NOT EXISTS doc_sends (
  id        TEXT PRIMARY KEY,
  t         INTEGER NOT NULL,   -- when it was sent (epoch ms)
  doc       TEXT NOT NULL,      -- the document number as written in the task message
  erp_name  TEXT,               -- its name in ERP
  doctype   TEXT,
  file      TEXT,               -- the file name the supplier received
  chat      TEXT NOT NULL,      -- the group it went to (jid)
  chat_name TEXT,
  supplier  TEXT,               -- ERP supplier
  caption   TEXT                -- the message sent with the PDF
);
CREATE INDEX IF NOT EXISTS idx_doc_sends_doc ON doc_sends (doc, t);
