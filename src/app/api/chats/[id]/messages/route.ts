import { chatApi } from "@/lib/chat-api";
import { ChatError, chatStore, type StoredAttachment } from "@/lib/chat-store";
import { discardUpload, limitedFormData, saveUpload } from "@/lib/chat-media";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, false, (user) => {
    const query = new URL(request.url).searchParams;
    const after = Number(query.get("after") || 0);
    const before = Number(query.get("before") || 0);
    if (![after, before].every((value) => Number.isSafeInteger(value) && value >= 0) || (after && before)) {
      throw new ChatError("Invalid message cursor.");
    }
    return Response.json({ messages: chatStore().messages(id, user.id, { after, before }) });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async (user) => {
    const store = chatStore();
    store.requireMember(id, user.id);
    const form = await limitedFormData(request);
    const text = form.get("text");
    const clientKey = form.get("clientKey");
    if (typeof text !== "string" || text.length > 10000 || typeof clientKey !== "string" || !/^[\w-]{1,80}$/.test(clientKey)) {
      throw new ChatError("Invalid message.");
    }
    const file = form.get("file");
    if (file !== null && !(file instanceof File)) throw new ChatError("Invalid attachment.");
    let attachment: StoredAttachment | undefined;
    try {
      if (file instanceof File) attachment = await saveUpload(file);
      const result = store.sendMessage(id, user, text, clientKey, attachment);
      if (!result.inserted && attachment) await discardUpload(attachment);
      return Response.json({ id: result.id }, { status: result.inserted ? 201 : 200 });
    } catch (error) {
      if (attachment) await discardUpload(attachment);
      throw error;
    }
  });
}
