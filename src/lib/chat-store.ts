import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatSummary, ChatUser } from "./chat-types";
import { storageBackend, cloudStorage } from "./cloudflare-storage";
import type { D1ChatStore } from "./d1-chat-store";
import { LANGUAGE_SCHEMA } from "./language-schema";
import { SESSION_SCHEMA } from "./session-schema";
import { chatInvitationKey } from "./chat-invites";

export class ChatError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "ChatError"; }
}

// The dev server and production route chunks can load separate class instances.
export function isChatError(error: unknown): error is ChatError {
  return error instanceof Error && error.name === "ChatError" &&
    Number.isInteger((error as ChatError).status) && (error as ChatError).status >= 400 && (error as ChatError).status < 500;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
export type StoredAttachment = NonNullable<ChatMessage["attachment"]> & { storageName: string };

export class ChatStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    // SQLite is only loaded for the offline Node server. Workers use D1.
    const { DatabaseSync } = createRequire(path.join(process.cwd(), "package.json"))("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        invite_hash TEXT UNIQUE NOT NULL, invite_expires INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (chat_id TEXT NOT NULL REFERENCES chats(id),
        user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(chat_id, user_id));
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES chats(id), sender_id TEXT NOT NULL REFERENCES users(id),
        client_key TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(chat_id, sender_id, client_key));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY,
        message_id INTEGER UNIQUE NOT NULL REFERENCES messages(id), name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, storage_name TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id, id);
      CREATE INDEX IF NOT EXISTS members_user_id ON members(user_id);
    `);
    this.db.exec(SESSION_SCHEMA);
    for (const [table, column] of [["messages", "source_language"], ["chat_views", "input_language"]]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'en' CHECK(${column} IN ('en','es'))`);
      }
    }
    this.db.exec(LANGUAGE_SCHEMA);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  upsertUser(user: ChatUser) {
    this.db.prepare(`INSERT INTO users(id,name,email) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email`).run(user.id, user.name, user.email);
  }

  requireMember(chatId: string, userId: string) {
    if (!this.db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(chatId, userId)) {
      throw new ChatError("Chat not found.", 404);
    }
  }

  createChat(user: ChatUser) {
    return this.transaction(() => {
      this.upsertUser(user);
      const id = randomUUID();
      const token = chatInvitationKey(id);
      const now = Date.now();
      this.db.prepare("INSERT INTO chats VALUES(?,?,?,?,?)").run(id, user.id, hash(token), now + INVITE_TTL, now);
      this.db.prepare("INSERT INTO members VALUES(?,?)").run(id, user.id);
      return { id, token };
    });
  }

  refreshInvite(chatId: string, userId: string) {
    return this.transaction(() => {
      this.requireMember(chatId, userId);
      const chat = this.db.prepare("SELECT owner_id FROM chats WHERE id=?").get(chatId);
      if (chat?.owner_id !== userId) throw new ChatError("Only the chat creator can make an invitation.", 403);
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE chat_id=?").get(chatId)?.n) >= 2) {
        throw new ChatError("This chat already has two participants.", 409);
      }
      const token = chatInvitationKey(chatId);
      this.db.prepare("UPDATE chats SET invite_hash=?,invite_expires=? WHERE id=?")
        .run(hash(token), Date.now() + INVITE_TTL, chatId);
      return token;
    });
  }

  joinChat(token: string, user: ChatUser) {
    if (!/^[\w-]{43}$/.test(token)) throw new ChatError("Invitation not found.", 404);
    return this.transaction(() => {
      const chat = this.db.prepare("SELECT id,invite_expires FROM chats WHERE invite_hash=?").get(hash(token));
      if (!chat) throw new ChatError("Invitation not found.", 404);
      const id = String(chat.id);
      if (this.db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(id, user.id)) return id;
      if (Number(chat.invite_expires) < Date.now()) throw new ChatError("This invitation has expired. Ask for a new link.", 410);
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE chat_id=?").get(id)?.n);
      if (count >= 2) throw new ChatError("This invitation has already been used by another person.", 409);
      this.upsertUser(user);
      this.db.prepare("INSERT INTO members VALUES(?,?)").run(id, user.id);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(Date.now(), id);
      return id;
    });
  }

  invitation(token: string, userId: string) {
    if (!/^[\w-]{43}$/.test(token)) throw new ChatError("Invitation not found.", 404);
    const chat = this.db.prepare(`SELECT c.id,c.invite_expires,u.name FROM chats c JOIN users u ON u.id=c.owner_id WHERE invite_hash=?`).get(hash(token));
    if (!chat) throw new ChatError("Invitation not found.", 404);
    const id = String(chat.id);
    if (this.db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(id, userId)) return { id, joined: true, name: String(chat.name) };
    if (Number(chat.invite_expires) < Date.now()) throw new ChatError("This invitation has expired. Ask for a new link.", 410);
    if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE chat_id=?").get(id)?.n) >= 2) {
      throw new ChatError("This invitation has already been used by another person.", 409);
    }
    return { id, joined: false, name: String(chat.name) };
  }

  currentInvite(chatId: string, userId: string) {
    this.requireMember(chatId, userId);
    const row = this.db.prepare("SELECT owner_id,invite_hash,invite_expires FROM chats WHERE id=?").get(chatId);
    if (row?.owner_id !== userId || Number(row.invite_expires) < Date.now()) return null;
    const token = chatInvitationKey(chatId);
    return row.invite_hash === hash(token) ? token : null;
  }

  listChats(userId: string): ChatSummary[] {
    return this.db.prepare(`SELECT c.id, c.owner_id, c.updated_at,
      (SELECT u.name FROM members p JOIN users u ON u.id=p.user_id WHERE p.chat_id=c.id AND p.user_id<>?) AS peer,
      (SELECT COUNT(*) FROM members WHERE chat_id=c.id) AS count,
      (SELECT CASE WHEN text<>'' THEN text ELSE 'Attachment' END FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message
      FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.user_id=? ORDER BY c.updated_at DESC,c.id`)
      .all(userId, userId).map((row) => ({ id: String(row.id), title: row.peer ? String(row.peer) : "Waiting for a friend",
        joined: Number(row.count) === 2, owned: row.owner_id === userId, updatedAt: Number(row.updated_at), lastMessage: String(row.last_message ?? "No messages yet") }));
  }

  messages(chatId: string, userId: string, { after = 0, before = 0 } = {}): ChatMessage[] {
    this.requireMember(chatId, userId);
    const newer = after > 0;
    const rows = this.db.prepare(`SELECT m.*,u.name AS sender_name,a.id AS attachment_id,a.name AS attachment_name,a.mime,a.size
      FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN attachments a ON a.message_id=m.id
      WHERE m.chat_id=? ${newer ? "AND m.id>?" : before > 0 ? "AND m.id<?" : ""}
      ORDER BY m.id ${newer ? "ASC" : "DESC"} LIMIT 100`).all(...(after || before ? [chatId, after || before] : [chatId]));
    if (!newer) rows.reverse();
    return rows.map((row) => ({ id: Number(row.id), chatId: String(row.chat_id), senderId: String(row.sender_id),
      senderName: String(row.sender_name), text: String(row.text), sourceLanguage: row.source_language === "es" ? "es" : "en", createdAt: Number(row.created_at),
      attachment: row.attachment_id ? { id: String(row.attachment_id), name: String(row.attachment_name), mime: String(row.mime), size: Number(row.size) } : null }));
  }

  sendMessage(chatId: string, user: ChatUser, text: string, clientKey: string, attachment?: StoredAttachment, sourceLanguage: "en" | "es" = "en") {
    if (text.length > 10000) throw new ChatError("Messages can contain at most 10,000 characters.");
    if (!text.trim() && !attachment) throw new ChatError("Enter a message or choose an image or video.");
    if (!/^[\w-]{1,80}$/.test(clientKey)) throw new ChatError("Invalid message identifier.");
    return this.transaction(() => {
      this.requireMember(chatId, user.id);
      const existing = this.db.prepare("SELECT id FROM messages WHERE chat_id=? AND sender_id=? AND client_key=?").get(chatId, user.id, clientKey);
      if (existing) return { id: Number(existing.id), inserted: false };
      this.upsertUser(user);
      const now = Date.now();
      const result = this.db.prepare("INSERT INTO messages(chat_id,sender_id,client_key,text,created_at,source_language) VALUES(?,?,?,?,?,?)")
        .run(chatId, user.id, clientKey, text.trim(), now, sourceLanguage);
      const id = Number(result.lastInsertRowid);
      if (attachment) this.db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?)")
        .run(attachment.id, id, attachment.name, attachment.mime, attachment.size, attachment.storageName);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now, chatId);
      return { id, inserted: true };
    });
  }

  attachment(id: string, userId: string): StoredAttachment {
    const row = this.db.prepare(`SELECT a.*,m.chat_id FROM attachments a JOIN messages m ON m.id=a.message_id
      JOIN members p ON p.chat_id=m.chat_id WHERE a.id=? AND p.user_id=?`).get(id, userId);
    if (!row) throw new ChatError("Attachment not found.", 404);
    return { id: String(row.id), name: String(row.name), mime: String(row.mime), size: Number(row.size), storageName: String(row.storage_name) };
  }
}

export function dataDirectory() {
  // User data is created at runtime and must never be traced into deployment files.
  return path.resolve(/* turbopackIgnore: true */ process.env.PCHAT_DATA_DIR || path.join(process.cwd(), "data"));
}
const globalStore = globalThis as typeof globalThis & { pchatStore?: ChatStore; pchatD1Store?: Promise<D1ChatStore> };
export async function chatStore(): Promise<ChatStore | D1ChatStore> {
  if (process.env.PCHAT_RUNTIME === "worker" && storageBackend() !== "cloudflare") {
    throw new Error("Cloudflare Workers require D1/R2 storage.");
  }
  if (storageBackend() === "cloudflare") {
    if (!globalStore.pchatD1Store) {
      globalStore.pchatD1Store = Promise.all([cloudStorage(), import("./d1-chat-store")])
        .then(([bindings, { D1ChatStore }]) => new D1ChatStore(bindings.DB))
        .catch((error) => { globalStore.pchatD1Store = undefined; throw error; });
    }
    return globalStore.pchatD1Store;
  }
  if (!globalStore.pchatStore) {
    mkdirSync(dataDirectory(), { recursive: true });
    globalStore.pchatStore = new ChatStore(path.join(dataDirectory(), "pchat.sqlite"));
  }
  return globalStore.pchatStore;
}
