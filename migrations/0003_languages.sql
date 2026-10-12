ALTER TABLE messages ADD COLUMN source_language TEXT NOT NULL DEFAULT 'en' CHECK(source_language IN ('en','es'));
ALTER TABLE chat_views ADD COLUMN input_language TEXT NOT NULL DEFAULT 'en' CHECK(input_language IN ('en','es'));
CREATE TABLE user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferred_language TEXT NOT NULL DEFAULT 'en' CHECK(preferred_language IN ('en','es')));
CREATE TABLE message_translations (message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, target_language TEXT NOT NULL CHECK(target_language IN ('en','es')), translated_text TEXT, status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')), lease TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(message_id,target_language));
