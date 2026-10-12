import { chatApi } from "@/lib/chat-api";
import { subscribeUser } from "@/lib/chat-live";
export async function GET(request: Request) {
  return chatApi(request, false, user => {
    if (process.env.PCHAT_RUNTIME === "worker") return Response.json({ error: "Use the WebSocket connection." }, { status: 404 });
    const encoder = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream({
      start(controller) {
        const send = () => controller.enqueue(encoder.encode("data: invalidate\n\n"));
        const unsubscribe = subscribeUser(user.id, send);
        const timer = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 20000);
        stop = () => { unsubscribe(); clearInterval(timer); request.signal.removeEventListener("abort", abort); };
        const abort = () => { stop(); try { controller.close(); } catch {} };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort(); else send();
      }, cancel() { stop(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
  });
}
