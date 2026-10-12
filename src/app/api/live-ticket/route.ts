import { chatApi } from "@/lib/chat-api";
import { mintLiveTicket } from "@/lib/live-ticket";
export async function POST(request: Request) {
  return chatApi(request, true, async user => Response.json(process.env.PCHAT_RUNTIME === "worker"
    ? { kind: "websocket", ticket: await mintLiveTicket(user.id, process.env.AUTH_SECRET!) }
    : { kind: "sse" }));
}
