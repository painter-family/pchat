import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";

export async function GET(request: Request) {
  return chatApi(request, false, async (user) => Response.json({ chats: await (await chatStore()).listChats(user.id) }));
}
export async function POST(request: Request) {
  return chatApi(request, true, async (user) => Response.json(await (await chatStore()).createChat(user), { status: 201 }));
}
