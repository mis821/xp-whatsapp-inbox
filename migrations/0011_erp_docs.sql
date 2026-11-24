-- ERP documents looked up for the 🧾 Reconciliation tab, so each number is not searched in ERP
-- on every page load. Found documents are re-checked after 6 hours, missing ones after 1 hour.
CREATE TABLE IF NOT EXISTS erp_docs (
  q       TEXT PRIMARY KEY,     -- the document number as written in the task message
  found   INTEGER NOT NULL,     -- 1 = found in ERP, 0 = not found
  info    TEXT,                 -- JSON: doctype, name, supplier, date, amount, status
  checked INTEGER NOT NULL      -- when ERP was last asked (epoch ms)
);
