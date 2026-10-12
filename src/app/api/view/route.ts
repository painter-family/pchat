import { chatApi } from "@/lib/chat-api";
import { ChatError } from "@/lib/chat-store";
import { userSessions } from "@/lib/user-sessions";
import { notifyUsers } from "@/lib/chat-live";
export async function GET(request: Request) {
  return chatApi(request, false, async user => Response.json({ ...await (await userSessions()).userView(user.id), user }));
}
export async function PATCH(request: Request) {
  return chatApi(request, true, async user => {
    const body = await request.json().catch(() => null);
    if (!body || (body.selectedChatId !== null && (typeof body.selectedChatId !== "string" || body.selectedChatId.length > 100))) throw new ChatError("Invalid selected conversation.");
    // Only a first direct chat URL may initialize an empty saved selection.
    // A device resuming an old URL must not overwrite another device's choice.
    if (body.initialize && (await (await userSessions()).userView(user.id)).revision > 0) return Response.json(await (await userSessions()).userView(user.id));
    const view = await (await userSessions()).selectChat(user, body.selectedChatId, body.initialize === true);
    await notifyUsers([user.id]);
    return Response.json(view);
  });
}
