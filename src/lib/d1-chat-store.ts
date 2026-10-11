import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { ChatError, INVITE_TTL, type StoredAttachment } from "./chat-store";
import type { ChatMessage, ChatSummary, ChatUser } from "./chat-types";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class D1ChatStore {
  constructor(readonly db: D1Database) {}

  private userStatement(user: ChatUser) {
    return this.db.prepare(`INSERT INTO users(id,name,email) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email`).bind(user.id, user.name, user.email);
  }

  async requireMember(chatId: string, userId: string) {
    if (!await this.db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").bind(chatId, userId).first()) {
      throw new ChatError("Chat not found.", 404);
    }
  }

  async createChat(user: ChatUser) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.db.batch([
      this.userStatement(user),
      this.db.prepare("INSERT INTO chats VALUES(?,?,?,?,?)").bind(id, user.id, hash(token), now + INVITE_TTL, now),
      this.db.prepare("INSERT INTO members VALUES(?,?)").bind(id, user.id),
    ]);
    return { id, token };
  }

  async refreshInvite(chatId: string, userId: string) {
    await this.requireMember(chatId, userId);
    const token = randomBytes(32).toString("base64url");
    const result = await this.db.prepare(`UPDATE chats SET invite_hash=?,invite_expires=? WHERE id=? AND owner_id=?
      AND (SELECT COUNT(*) FROM members WHERE chat_id=chats.id)<2`)
      .bind(hash(token), Date.now() + INVITE_TTL, chatId, userId).run();
    if (!result.meta.changes) {
      const chat = await this.db.prepare("SELECT owner_id FROM chats WHERE id=?").bind(chatId).first<{ owner_id: string }>();
      if (chat?.owner_id !== userId) throw new ChatError("Only the chat creator can make an invitation.", 403);
      throw new ChatError("This chat already has two participants.", 409);
    }
    return token;
  }

  async invitation(token: string, userId: string) {
    if (!/^[\w-]{43}$/.test(token)) throw new ChatError("Invitation not found.", 404);
    const chat = await this.db.prepare(`SELECT c.id,c.invite_expires,u.name,
      EXISTS(SELECT 1 FROM members WHERE chat_id=c.id AND user_id=?) AS joined,
      (SELECT COUNT(*) FROM members WHERE chat_id=c.id) AS count
      FROM chats c JOIN users u ON u.id=c.owner_id WHERE invite_hash=?`)
      .bind(userId, hash(token)).first<{ id: string; invite_expires: number; name: string; joined: number; count: number }>();
    if (!chat) throw new ChatError("Invitation not found.", 404);
    if (chat.joined) return { id: chat.id, joined: true, name: chat.name };
    if (chat.invite_expires < Date.now()) throw new ChatError("This invitation has expired. Ask for a new link.", 410);
    if (chat.count >= 2) throw new ChatError("This invitation has already been used by another person.", 409);
    return { id: chat.id, joined: false, name: chat.name };
  }

  async joinChat(token: string, user: ChatUser) {
    const invite = await this.invitation(token, user.id);
    if (invite.joined) return invite.id;
    // The seat check is inside the write, so two concurrent claimants cannot both join.
    await this.db.batch([
      this.userStatement(user),
      this.db.prepare(`INSERT INTO members(chat_id,user_id)
        SELECT id,? FROM chats WHERE id=? AND invite_hash=? AND invite_expires>=?
        AND (SELECT COUNT(*) FROM members WHERE chat_id=chats.id)<2
        ON CONFLICT(chat_id,user_id) DO NOTHING`).bind(user.id, invite.id, hash(token), Date.now()),
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=? AND changes()>0").bind(Date.now(), invite.id),
    ]);
    const joined = await this.invitation(token, user.id);
    if (!joined.joined) throw new ChatError("This invitation has already been used by another person.", 409);
    return joined.id;
  }

  async listChats(userId: string): Promise<ChatSummary[]> {
    const { results } = await this.db.prepare(`SELECT c.id,c.updated_at,
      (SELECT u.name FROM members p JOIN users u ON u.id=p.user_id WHERE p.chat_id=c.id AND p.user_id<>?) AS peer,
      (SELECT COUNT(*) FROM members WHERE chat_id=c.id) AS count,
      (SELECT CASE WHEN text<>'' THEN text ELSE 'Attachment' END FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message
      FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.user_id=? ORDER BY c.updated_at DESC,c.id`).bind(userId, userId).all();
    return results.map((row) => ({ id: String(row.id), title: row.peer ? String(row.peer) : "Waiting for a friend",
      joined: Number(row.count) === 2, updatedAt: Number(row.updated_at), lastMessage: String(row.last_message ?? "No messages yet") }));
  }

  async messages(chatId: string, userId: string, { after = 0, before = 0 } = {}): Promise<ChatMessage[]> {
    await this.requireMember(chatId, userId);
    const newer = after > 0;
    const statement = this.db.prepare(`SELECT m.*,u.name AS sender_name,a.id AS attachment_id,a.name AS attachment_name,a.mime,a.size
      FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN attachments a ON a.message_id=m.id
      WHERE m.chat_id=? ${newer ? "AND m.id>?" : before > 0 ? "AND m.id<?" : ""}
      ORDER BY m.id ${newer ? "ASC" : "DESC"} LIMIT 100`);
    const { results } = await statement.bind(...(after || before ? [chatId, after || before] : [chatId])).all();
    if (!newer) results.reverse();
    return results.map((row) => ({ id: Number(row.id), chatId: String(row.chat_id), senderId: String(row.sender_id),
      senderName: String(row.sender_name), text: String(row.text), createdAt: Number(row.created_at),
      attachment: row.attachment_id ? { id: String(row.attachment_id), name: String(row.attachment_name), mime: String(row.mime), size: Number(row.size) } : null }));
  }

  async sendMessage(chatId: string, user: ChatUser, text: string, clientKey: string, attachment?: StoredAttachment) {
    if (text.length > 10000) throw new ChatError("Messages can contain at most 10,000 characters.");
    if (!text.trim() && !attachment) throw new ChatError("Enter a message or choose an image or video.");
    if (!/^[\w-]{1,80}$/.test(clientKey)) throw new ChatError("Invalid message identifier.");
    await this.requireMember(chatId, user.id);
    const now = Date.now();
    const statements = [this.userStatement(user),
      this.db.prepare(`INSERT INTO messages(chat_id,sender_id,client_key,text,created_at)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE chat_id=? AND user_id=?)
        ON CONFLICT(chat_id,sender_id,client_key) DO NOTHING`).bind(chatId, user.id, clientKey, text.trim(), now, chatId, user.id)];
    if (attachment) statements.push(this.db.prepare(`INSERT INTO attachments(id,message_id,name,mime,size,storage_name)
      SELECT ?,id,?,?,?,? FROM messages WHERE chat_id=? AND sender_id=? AND client_key=? AND changes()>0`)
      .bind(attachment.id, attachment.name, attachment.mime, attachment.size, attachment.storageName, chatId, user.id, clientKey));
    statements.push(this.db.prepare("UPDATE chats SET updated_at=? WHERE id=? AND changes()>0").bind(now, chatId));
    statements.push(this.db.prepare("SELECT id FROM messages WHERE chat_id=? AND sender_id=? AND client_key=?").bind(chatId, user.id, clientKey));
    // changes() refers to the previous statement within this atomic batch. A retry
    // cannot replace the winning request's attachment or update its timestamp.
    const result = await this.db.batch<{ id: number }>(statements);
    const row = result[result.length - 1].results[0];
    if (!row) throw new ChatError("Chat not found.", 404);
    return { id: row.id, inserted: result[1].meta.changes > 0 };
  }

  async attachment(id: string, userId: string): Promise<StoredAttachment> {
    const row = await this.db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id
      JOIN members p ON p.chat_id=m.chat_id WHERE a.id=? AND p.user_id=?`).bind(id, userId).first();
    if (!row) throw new ChatError("Attachment not found.", 404);
    return { id: String(row.id), name: String(row.name), mime: String(row.mime), size: Number(row.size), storageName: String(row.storage_name) };
  }
}
