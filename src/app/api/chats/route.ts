import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";

export async function GET(request: Request) {
  return chatApi(request, false, (user) => Response.json({ chats: chatStore().listChats(user.id) }));
}
export async function POST(request: Request) {
  return chatApi(request, true, (user) => Response.json(chatStore().createChat(user), { status: 201 }));
}
