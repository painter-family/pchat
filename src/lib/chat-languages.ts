import type { ChatMessage, ChatSummary, ChatUser, Language } from "./chat-types";
import { ChatError } from "./chat-store";
import { cloudStorage, storageBackend } from "./cloudflare-storage";
import { UserSessions, userSessions } from "./user-sessions";
import { notifyUsers } from "./chat-live";

export const languageName = { en: "English", es: "Spanish" };
export function isLanguage(value: unknown): value is Language { return value === "en" || value === "es"; }
type Translate = (text: string, source: Language, target: Language) => Promise<string>;

export async function translateText(text: string, source: Language, target: Language) {
  if (storageBackend() === "local") throw new Error("Translation requires Cloudflare storage and its AI binding.");
  const ai = (await cloudStorage()).AI;
  if (!ai) throw new Error("Cloudflare AI binding is missing.");
  // Small chunks keep long messages within the translation model's output limit.
  // Preserve whitespace and paragraph separators between chunks.
  const chunks = text.match(/[^\n]{1,400}(?:\s|$)|[^\n]{1,400}|\n+/g) || [text];
  const output: string[] = [];
  for (let offset = 0; offset < chunks.length; offset += 3) {
    const translated = await Promise.all(chunks.slice(offset, offset + 3).map(async chunk => {
      if (!chunk.trim()) return chunk;
      const trailing = chunk.match(/\s+$/)?.[0] || "";
      const leading = chunk.match(/^\s+/)?.[0] || "";
      const result = await ai.run("@cf/meta/m2m100-1.2b", {
        text: chunk.trim(), source_lang: languageName[source].toLowerCase(), target_lang: languageName[target].toLowerCase(),
      });
      if (!result.translated_text?.trim()) throw new Error("Empty translation response.");
      return leading + result.translated_text.trim() + trailing;
    }));
    output.push(...translated);
  }
  return output.join("");
}

export class ChatLanguages {
  constructor(readonly sessions: UserSessions, readonly translate: Translate = translateText) {}
  async preferred(userId: string): Promise<Language> {
    return (await this.sessions.first<{ preferred_language: Language }>("SELECT preferred_language FROM user_preferences WHERE user_id=?", [userId]))?.preferred_language || "en";
  }
  async setPreferred(user: ChatUser, language: Language) {
    if (!isLanguage(language)) throw new ChatError("Invalid reading language.");
    await this.sessions.batch([
      { sql: "INSERT INTO users(id,name,email) VALUES(?,?,?) ON CONFLICT DO NOTHING", values: [user.id, user.name, user.email] },
      { sql: "INSERT INTO user_preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET preferred_language=excluded.preferred_language", values: [user.id, language] },
    ]);
  }
  async decorate(messages: ChatMessage[], userId: string, target?: Language) {
    target ||= await this.preferred(userId);
    if (!messages.length) return messages;
    const rows = await this.sessions.all<{ message_id: number; translated_text: string | null; status: "pending" | "ready" | "failed" }>(
      `SELECT message_id,translated_text,status FROM message_translations WHERE target_language=? AND message_id IN(${messages.map(() => "?").join(",")})`, [target, ...messages.map(m => m.id)]);
    const translations = new Map(rows.map(row => [row.message_id, row]));
    return messages.map(message => {
      if (!message.text || message.senderId === userId || (message.sourceLanguage || "en") === target) return { ...message, translation: undefined };
      const row = translations.get(message.id);
      return { ...message, translation: { targetLanguage: target, status: row?.status || "pending", text: row?.translated_text || null } };
    });
  }
  async summaries(chats: ChatSummary[], userId: string): Promise<ChatSummary[]> {
    const target = await this.preferred(userId);
    return Promise.all(chats.map(async chat => {
      const view = await this.sessions.chatView(chat.id, userId);
      const row = await this.sessions.first<{ id: number; sender_id: string; text: string; source_language: Language; created_at: number }>("SELECT id,sender_id,text,source_language,created_at FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1", [chat.id]);
      const message: ChatMessage | undefined = row ? { id: row.id, chatId: chat.id, senderId: row.sender_id, senderName: "", text: row.text, sourceLanguage: row.source_language, createdAt: row.created_at, attachment: null } : undefined;
      const preview = message ? (await this.decorate([message], userId, target))[0] : undefined;
      return { ...chat, inputLanguage: view.inputLanguage, previewMessage: preview, lastMessage: preview?.translation?.status === "ready" ? preview.translation.text! : preview?.translation ? "Translating…" : chat.lastMessage };
    }));
  }
  async request(chatId: string, userId: string, ids: number[], retry = false) {
    await this.sessions.chatView(chatId, userId); // Authorize before looking up any message or calling AI.
    const target = await this.preferred(userId);
    const rows = await this.sessions.all<{ id: number; sender_id: string; text: string; source_language: Language; created_at: number }>(
      `SELECT id,sender_id,text,source_language,created_at FROM messages WHERE chat_id=? AND id IN(${ids.map(() => "?").join(",")})`, [chatId, ...ids]);
    let changed = false;
    for (const row of rows) {
      if (!row.text || row.sender_id === userId || row.source_language === target) continue;
      const lease = crypto.randomUUID();
      const now = Date.now();
      // A persisted lease deduplicates requests across devices. An interrupted
      // request becomes eligible again on a subsequent view after two minutes.
      const claimed = await this.sessions.first(`INSERT INTO message_translations(message_id,target_language,status,lease,updated_at)
        VALUES(?,?,'pending',?,?) ON CONFLICT(message_id,target_language) DO UPDATE SET status='pending',lease=excluded.lease,updated_at=excluded.updated_at
        WHERE (message_translations.status='pending' AND message_translations.updated_at<?)
        OR (message_translations.status='failed' AND ?) RETURNING message_id`, [row.id, target, lease, now, now - 120000, retry ? 1 : 0]);
      if (!claimed) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const text = await Promise.race([
          this.translate(row.text, row.source_language, target),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Translation timed out.")), 45000); }),
        ]);
        await this.sessions.batch([{ sql: "UPDATE message_translations SET translated_text=?,status='ready',updated_at=? WHERE message_id=? AND target_language=? AND lease=?", values: [text, Date.now(), row.id, target, lease] }]);
      } catch {
        // Never log private message text or make a failed translation fail delivery.
        await this.sessions.batch([{ sql: "UPDATE message_translations SET status='failed',updated_at=? WHERE message_id=? AND target_language=? AND lease=?", values: [Date.now(), row.id, target, lease] }]);
      } finally { clearTimeout(timer); }
      changed = true;
    }
    if (changed) await notifyUsers(await this.sessions.memberIds(chatId));
    const messages: ChatMessage[] = rows.map(row => ({ id: row.id, chatId, senderId: row.sender_id, senderName: "", text: row.text, sourceLanguage: row.source_language, createdAt: row.created_at, attachment: null }));
    return this.decorate(messages, userId, target);
  }
}
export async function chatLanguages() { return new ChatLanguages(await userSessions()); }
