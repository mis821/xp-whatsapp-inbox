-- Dashboard sign-ins. Each sign-in is a row, so a lock (Windows+L, idle time, the Lock button)
-- ends it on the server too — the browser cannot simply be reloaded past the lock screen.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  created     INTEGER NOT NULL,
  last_active INTEGER NOT NULL,     -- last time someone was actually using the dashboard
  via         TEXT                  -- password | fingerprint
);

-- Fingerprint sign-in (Windows Hello passkeys). Only the public key is kept; the private key
-- never leaves the laptop's security chip.
CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT PRIMARY KEY,      -- credential id, base64url
  pk         TEXT NOT NULL,         -- public key (SPKI, base64url)
  alg        INTEGER NOT NULL,      -- -7 ES256 | -257 RS256
  name       TEXT,
  created    INTEGER NOT NULL,
  last_used  INTEGER,
  sign_count INTEGER NOT NULL DEFAULT 0
);

-- One-time challenges for fingerprint sign-in and registration (valid for two minutes).
CREATE TABLE IF NOT EXISTS challenges (
  c    TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- login | reg
  exp  INTEGER NOT NULL
);
