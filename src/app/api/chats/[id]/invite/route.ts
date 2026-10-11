import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async (user) => Response.json({ token: await (await chatStore()).refreshInvite(id, user.id) }));
}
