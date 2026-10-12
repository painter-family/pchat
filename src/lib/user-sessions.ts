import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { ChatError, chatStore } from "./chat-store";
import type { ChatUser, ChatView, UserView } from "./chat-types";

type Values = (string | number | null)[];
type Statement = { sql: string; values: Values };

export class UserSessions {
  constructor(readonly db: DatabaseSync | D1Database) {}
  async first<T>(sql: string, values: Values = []): Promise<T | null> {
    if ("batch" in this.db) return this.db.prepare(sql).bind(...values).first<T>();
    return (this.db.prepare(sql).get(...values) as T | undefined) ?? null;
  }
  async all<T>(sql: string, values: Values = []): Promise<T[]> {
    if ("batch" in this.db) return (await this.db.prepare(sql).bind(...values).all<T>()).results;
    return this.db.prepare(sql).all(...values) as T[];
  }
  async batch(statements: Statement[]) {
    const db = this.db;
    if ("batch" in db) {
      await db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
    } else {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, values } of statements) this.db.prepare(sql).run(...values);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  async canonicalId(id: string) {
    return (await this.first<{ user_id: string }>("SELECT user_id FROM user_aliases WHERE alias_id=?", [id]))?.user_id || id;
  }

  async googleAccount(subject: string, profile: { email: string; name: string; verified: boolean }) {
    if (!subject || !profile.verified || !profile.email) throw new ChatError("A verified Google identity is required.", 403);
    const email = profile.email.toLowerCase();
    const mapped = await this.first<{ user_id: string }>("SELECT user_id FROM google_accounts WHERE subject=?", [subject]);
    // Legacy Auth.js sessions used random IDs. Claim only unclaimed legacy
    // records matching Google's verified email, never a client-supplied email.
    const legacy = mapped ? null : await this.first<{ id: string }>(`SELECT u.id FROM users u WHERE lower(email)=?
      AND NOT EXISTS(SELECT 1 FROM google_accounts g WHERE g.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM user_aliases a WHERE a.alias_id=u.id)
      ORDER BY u.id LIMIT 1`, [email]);
    const candidate = mapped?.user_id || legacy?.id || `google-${subject}`;
    await this.batch([
      { sql: "INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", values: [candidate, profile.name, email] },
      { sql: "INSERT INTO google_accounts VALUES(?,?) ON CONFLICT(subject) DO NOTHING", values: [subject, candidate] },
    ]);
    const id = (await this.first<{ user_id: string }>("SELECT user_id FROM google_accounts WHERE subject=?", [subject]))!.user_id;
    await this.batch([
      { sql: `INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email`, values: [id, profile.name, email] },
      { sql: "INSERT INTO google_accounts VALUES(?,?) ON CONFLICT(subject) DO NOTHING", values: [subject, id] },
      { sql: `INSERT INTO user_aliases(alias_id,user_id) SELECT u.id,? FROM users u WHERE lower(u.email)=?
        AND NOT EXISTS(SELECT 1 FROM google_accounts g WHERE g.user_id=u.id AND g.subject<>?)
        AND NOT EXISTS(SELECT 1 FROM user_aliases a WHERE a.alias_id=u.id AND a.user_id<>?)
        ON CONFLICT(alias_id) DO NOTHING`, values: [id, email, subject, id] },
      { sql: `INSERT INTO members(chat_id,user_id) SELECT DISTINCT m.chat_id,? FROM members m
        JOIN user_aliases a ON a.alias_id=m.user_id WHERE a.user_id=? ON CONFLICT(chat_id,user_id) DO NOTHING`, values: [id, id] },
      { sql: `UPDATE chats SET owner_id=? WHERE owner_id IN(SELECT alias_id FROM user_aliases WHERE user_id=?)`, values: [id, id] },
      // Reserved ':' keys cannot collide with valid client-generated keys.
      { sql: `UPDATE messages SET sender_id=?,client_key='legacy:'||id WHERE sender_id<>?
        AND sender_id IN(SELECT alias_id FROM user_aliases WHERE user_id=?)`, values: [id, id, id] },
      { sql: `DELETE FROM members WHERE user_id<>? AND user_id IN(SELECT alias_id FROM user_aliases WHERE user_id=?)`, values: [id, id] },
      { sql: `INSERT INTO user_views(user_id,selected_chat_id,revision) SELECT ?,v.selected_chat_id,v.revision FROM user_views v
        JOIN user_aliases a ON a.alias_id=v.user_id WHERE a.user_id=? ORDER BY v.revision DESC LIMIT 1
        ON CONFLICT(user_id) DO NOTHING`, values: [id, id] },
      { sql: `INSERT INTO chat_views(user_id,chat_id,draft,anchor_id,anchor_offset,revision,draft_revision)
        SELECT ?,chat_id,draft,anchor_id,anchor_offset,revision,draft_revision FROM (
          SELECT v.*,ROW_NUMBER() OVER(PARTITION BY v.chat_id ORDER BY v.revision DESC) AS priority FROM chat_views v
          JOIN user_aliases a ON a.alias_id=v.user_id WHERE a.user_id=?) WHERE priority=1
        ON CONFLICT(user_id,chat_id) DO NOTHING`, values: [id, id] },
    ]);
    return (await this.first<{ user_id: string }>("SELECT user_id FROM google_accounts WHERE subject=?", [subject]))!.user_id;
  }

  async userView(userId: string): Promise<UserView> {
    const row = await this.first<{ selected_chat_id: string | null; revision: number }>("SELECT selected_chat_id,revision FROM user_views WHERE user_id=?", [userId]);
    return { selectedChatId: row?.selected_chat_id || null, revision: row?.revision || 0 };
  }
  async selectChat(user: ChatUser, id: string | null, initialize = false) {
    if (id && !await this.first("SELECT 1 FROM members WHERE chat_id=? AND user_id=?", [id, user.id])) throw new ChatError("Chat not found.", 404);
    await this.batch([
      { sql: "INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", values: [user.id, user.name, user.email] },
      { sql: `INSERT INTO user_views VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET
        selected_chat_id=excluded.selected_chat_id,revision=user_views.revision+1 ${initialize ? "WHERE user_views.revision=0" : ""}`, values: [user.id, id] },
    ]);
    return this.userView(user.id);
  }
  async chatView(chatId: string, userId: string): Promise<ChatView> {
    if (!await this.first("SELECT 1 FROM members WHERE chat_id=? AND user_id=?", [chatId, userId])) throw new ChatError("Chat not found.", 404);
    const row = await this.first<{ draft: string; draft_revision: number; anchor_id: number | null; anchor_offset: number; revision: number }>(
      "SELECT draft,draft_revision,anchor_id,anchor_offset,revision FROM chat_views WHERE user_id=? AND chat_id=?", [userId, chatId]);
    return { draft: row?.draft || "", draftRevision: row?.draft_revision || 0, anchorId: row?.anchor_id ?? null, anchorOffset: row?.anchor_offset || 0, revision: row?.revision || 0 };
  }
  async updateChatView(chatId: string, userId: string, expectedRevision: number, patch: Partial<Pick<ChatView, "draft" | "anchorId" | "anchorOffset">>) {
    if (!await this.first("SELECT 1 FROM members WHERE chat_id=? AND user_id=?", [chatId, userId])) throw new ChatError("Chat not found.", 404);
    const fields: string[] = [];
    const values: Values = [];
    if (patch.draft !== undefined) { fields.push("draft=?", "draft_revision=draft_revision+1"); values.push(patch.draft); }
    if (patch.anchorId !== undefined) { fields.push("anchor_id=?"); values.push(patch.anchorId); }
    if (patch.anchorOffset !== undefined) { fields.push("anchor_offset=?"); values.push(patch.anchorOffset); }
    if (!fields.length) throw new ChatError("No view changes supplied.");
    if (patch.anchorId != null && !await this.first("SELECT id FROM messages WHERE id=? AND chat_id=?", [patch.anchorId, chatId])) {
      throw new ChatError("Invalid reading position.");
    }
    // Compare-and-set prevents a suspended device overwriting a newer draft.
    // RETURNING identifies this write, even if another client updates afterward.
    await this.batch([{ sql: "INSERT INTO chat_views(user_id,chat_id) VALUES(?,?) ON CONFLICT DO NOTHING", values: [userId, chatId] }]);
    const row = await this.first<{ revision: number }>(`UPDATE chat_views SET ${fields.join(",")},revision=revision+1
      WHERE user_id=? AND chat_id=? AND revision=? RETURNING revision`, [...values, userId, chatId, expectedRevision]);
    if (!row) throw new ChatError("The view changed on another device. The latest saved view has been restored.", 409);
    return this.chatView(chatId, userId);
  }
  async clearSentDraft(chatId: string, userId: string, revision: number, text: string) {
    await this.batch([{ sql: `UPDATE chat_views SET draft='',draft_revision=draft_revision+1,revision=revision+1 WHERE user_id=? AND chat_id=? AND draft_revision=? AND draft=?`, values: [userId, chatId, revision, text] }]);
  }
  async memberIds(chatId: string) {
    return (await this.all<{ user_id: string }>("SELECT user_id FROM members WHERE chat_id=?", [chatId])).map(row => row.user_id);
  }
}

export async function userSessions() { return new UserSessions((await chatStore()).db); }
