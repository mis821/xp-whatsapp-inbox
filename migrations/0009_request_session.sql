-- Which Claude conversation a request is for (chosen on the dashboard). The list of conversations
-- to choose from is kept in settings ('claude_sessions'), refreshed by Claude on its hourly check.
ALTER TABLE requests ADD COLUMN session TEXT;
ALTER TABLE requests ADD COLUMN session_title TEXT;
