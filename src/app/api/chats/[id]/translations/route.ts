import { chatApi } from "@/lib/chat-api";
import { ChatError } from "@/lib/chat-store";
import { chatLanguages } from "@/lib/chat-languages";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, true, async user => {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 3 ||
      !body.ids.every((value: unknown) => Number.isSafeInteger(value) && Number(value) > 0) ||
      (body.retry !== undefined && typeof body.retry !== "boolean")) throw new ChatError("Invalid translation request.");
    return Response.json({ messages: await (await chatLanguages()).request(id, user.id, [...new Set<number>(body.ids)], body.retry === true) });
  });
}
