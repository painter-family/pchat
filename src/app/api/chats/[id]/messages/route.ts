import { chatLanguages } from "@/lib/chat-languages";
import { chatApi } from "@/lib/chat-api";
import { ChatError, isChatError, chatStore, type StoredAttachment } from "@/lib/chat-store";
import { discardUpload, limitedFormData, saveUpload } from "@/lib/chat-media";
import { userSessions } from "@/lib/user-sessions";
import { notifyUsers } from "@/lib/chat-live";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, false, async (user) => {
    const query = new URL(request.url).searchParams;
    const after = Number(query.get("after") || 0);
    const before = Number(query.get("before") || 0);
    if (![after, before].every((value) => Number.isSafeInteger(value) && value >= 0) || (after && before)) {
      throw new ChatError("Invalid message cursor.");
    }
    return Response.json({ messages: await (await chatLanguages()).decorate(await (await chatStore()).messages(id, user.id, { after, before }), user.id) });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async (user) => {
    const store = await chatStore();
    await store.requireMember(id, user.id);
    const form = await limitedFormData(request);
    const text = form.get("text");
    const clientKey = form.get("clientKey");
    if (typeof text !== "string" || text.length > 10000 || typeof clientKey !== "string" || !/^[\w-]{1,80}$/.test(clientKey)) {
      throw new ChatError("Invalid message.");
    }
    const sourceLanguage = form.get("sourceLanguage") || "en";
    if (sourceLanguage !== "en" && sourceLanguage !== "es") throw new ChatError("Invalid writing language.");
    const file = form.get("file");
    if (file !== null && !(file instanceof File)) throw new ChatError("Invalid attachment.");
    let attachment: StoredAttachment | undefined;
    try {
      if (file instanceof File) attachment = await saveUpload(file);
      const result = await store.sendMessage(id, user, text, clientKey, attachment, sourceLanguage);
      if (!result.inserted && attachment) await discardUpload(attachment);
      const sessions = await userSessions();
      const revision = form.get("draftRevision");
      if (typeof revision === "string" && /^\d+$/.test(revision) && Number.isSafeInteger(Number(revision))) {
        await sessions.clearSentDraft(id, user.id, Number(revision), text);
      }
      await notifyUsers(await sessions.memberIds(id));
      return Response.json({ id: result.id }, { status: result.inserted ? 201 : 200 });
    } catch (error) {
      // A network failure can happen after D1 committed. Keep the object on an
      // uncertain outcome rather than breaking a message that already saved.
      if (attachment && isChatError(error)) await discardUpload(attachment);
      throw error;
    }
  });
}
