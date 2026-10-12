import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";
import { userSessions } from "@/lib/user-sessions";
import { notifyUsers } from "@/lib/chat-live";

export async function GET(request: Request) {
  return chatApi(request, false, async (user) => Response.json({ chats: await (await chatStore()).listChats(user.id) }));
}
export async function POST(request: Request) {
  return chatApi(request, true, async (user) => {
    const chat = await (await chatStore()).createChat(user);
    await (await userSessions()).selectChat(user, chat.id);
    await notifyUsers([user.id]);
    return Response.json(chat, { status: 201 });
  });
}
