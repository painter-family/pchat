CREATE TABLE google_accounts (
  subject TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id)
);
CREATE TABLE user_aliases (
  alias_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE user_views (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  selected_chat_id TEXT REFERENCES chats(id),
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chat_views (
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT NOT NULL REFERENCES chats(id),
  draft TEXT NOT NULL DEFAULT '',
  draft_revision INTEGER NOT NULL DEFAULT 0,
  anchor_id INTEGER,
  anchor_offset REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, chat_id)
);
CREATE INDEX user_aliases_user_id ON user_aliases(user_id);
