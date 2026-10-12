import app from "./.open-next/worker.js";
import { verifyLiveTicket } from "./src/lib/live-ticket.ts";
export { UserConnections } from "./src/cloudflare/user-connections.ts";

const worker = {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/api/live") return app.fetch(request, env, ctx);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (request.headers.get("Origin") !== env.AUTH_URL) return new Response(null, { status: 403 });
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(value => value.trim());
    const ticket = protocols.find(value => value.startsWith("ticket."))?.slice(7);
    const userId = protocols.includes("pchat.v1") && ticket && await verifyLiveTicket(ticket, env.AUTH_SECRET);
    if (!userId) return new Response(null, { status: 401 });
    return env.USER_CONNECTIONS.get(env.USER_CONNECTIONS.idFromName(userId)).fetch(request);
  },
};

export default worker;
