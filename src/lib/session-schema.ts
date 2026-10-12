// Offline SQLite uses the same additional tables as D1 migration 0002.
export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS google_accounts (subject TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS user_aliases (alias_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS user_views (user_id TEXT PRIMARY KEY REFERENCES users(id), selected_chat_id TEXT REFERENCES chats(id), revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_views (user_id TEXT NOT NULL REFERENCES users(id), chat_id TEXT NOT NULL REFERENCES chats(id), draft TEXT NOT NULL DEFAULT '', draft_revision INTEGER NOT NULL DEFAULT 0, anchor_id INTEGER, anchor_offset REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,chat_id));
CREATE INDEX IF NOT EXISTS user_aliases_user_id ON user_aliases(user_id);`;
