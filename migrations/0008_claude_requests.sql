-- Work requests for Claude, written on the dashboard's 🤖 Claude tab. Every hour Claude reads new
-- ones (through the "Claude requests" GitHub workflow) and asks for confirmation in the Claude
-- conversation; work starts only after that confirmation. Progress and results are written back here.
CREATE TABLE IF NOT EXISTS requests (
  id      TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  text    TEXT NOT NULL,
  status  TEXT NOT NULL DEFAULT 'new',   -- new | asked | working | done | failed | cancelled
  reply   TEXT,                          -- Claude's update or result
  updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status, created);
