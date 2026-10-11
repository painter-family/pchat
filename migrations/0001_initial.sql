-- Matches the app's current chat-store schema. D1 manages journaling and locking.
-- Attachment file contents will live in R2; this table stores their metadata.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  invite_hash TEXT UNIQUE NOT NULL,
  invite_expires INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, sender_id, client_key)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id INTEGER UNIQUE NOT NULL REFERENCES messages(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS members_user_id ON members(user_id);
