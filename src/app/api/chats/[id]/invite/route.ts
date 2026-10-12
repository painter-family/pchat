import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";
import { notifyUsers } from "@/lib/chat-live";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async (user) => {
    const token = await (await chatStore()).refreshInvite(id, user.id);
    await notifyUsers([user.id]);
    return Response.json({ token });
  });
}
