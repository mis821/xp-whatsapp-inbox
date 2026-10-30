-- Automatic forwards (FORWARD_RULES in src/app.js) go out through the outbox like replies.
-- WhatsApp Web forwards the original message, then sends `text` (the note) tagging `mentions`;
-- if it cannot find or forward the original it sends `copy` (the note with the message quoted).
ALTER TABLE outbox ADD COLUMN fwd_chat TEXT;     -- chat the original message is in
ALTER TABLE outbox ADD COLUMN fwd_msg TEXT;      -- messages.id of the original
ALTER TABLE outbox ADD COLUMN mentions TEXT;     -- phone numbers to @mention, comma-separated
ALTER TABLE outbox ADD COLUMN copy TEXT;
