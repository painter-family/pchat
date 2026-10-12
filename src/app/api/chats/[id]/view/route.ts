import { chatApi } from "@/lib/chat-api";
import { ChatError, chatStore } from "@/lib/chat-store";
import { userSessions } from "@/lib/user-sessions";
import { notifyUsers } from "@/lib/chat-live";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, false, async user => Response.json({
    ...await (await userSessions()).chatView(id, user.id),
    inviteToken: await (await chatStore()).currentInvite(id, user.id),
  }));
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async user => {
    const body = await request.json().catch(() => null);
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 ||
      (body.inputLanguage !== undefined && body.inputLanguage !== "en" && body.inputLanguage !== "es") ||
      (body.draft !== undefined && (typeof body.draft !== "string" || body.draft.length > 10000)) ||
      (body.anchorId !== undefined && body.anchorId !== null && (!Number.isSafeInteger(body.anchorId) || body.anchorId < 1)) ||
      (body.anchorOffset !== undefined && (!Number.isFinite(body.anchorOffset) || body.anchorOffset < 0 || body.anchorOffset > 1))) throw new ChatError("Invalid conversation view.");
    const patch = Object.fromEntries(["draft", "anchorId", "anchorOffset", "inputLanguage"].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    const view = await (await userSessions()).updateChatView(id, user.id, body.revision, patch);
    await notifyUsers([user.id]);
    return Response.json(view);
  });
}
