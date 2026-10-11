-- Messages removed because they were deleted on WhatsApp (deleted for everyone, deleted for me, or
-- the whole chat deleted). They disappear from every tab and the report; a copy stays here for
-- 30 days only so a mistaken removal could be restored by hand. Never shown on the dashboard.
CREATE TABLE IF NOT EXISTS trash (
  id         TEXT PRIMARY KEY,      -- messages.id
  deleted_at INTEGER NOT NULL,
  why        TEXT,                  -- revoked | deleted | chat
  msg        TEXT,                  -- the message row, as JSON
  flag       TEXT                   -- its Priority / Task List / Owners entry, as JSON (if any)
);
