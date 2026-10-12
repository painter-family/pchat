import type { DurableObjectState, WebSocket as CloudSocket } from "@cloudflare/workers-types";

// One named object per app user; any number of browsers can subscribe.
export class UserConnections {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    if (request.method === "POST") {
      for (const socket of this.state.getWebSockets()) {
        try { socket.send('{"type":"invalidate"}'); } catch { socket.close(); }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: CloudSocket; 1: CloudSocket } }).WebSocketPair;
    const pair = new Pair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ expires: Date.now() + 30 * 60 * 1000 });
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    pair[1].send('{"type":"invalidate"}');
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": "pchat.v1" } } as ResponseInit);
  }
  webSocketMessage(socket: CloudSocket, message: string | ArrayBuffer) {
    // Mutations always use authenticated HTTP APIs, never WebSocket messages.
    if (message === "ping") socket.send("pong");
  }
  webSocketClose(socket: CloudSocket, code: number) { socket.close(code, "Connection closed"); }
  webSocketError(socket: CloudSocket) { socket.close(1011, "Reconnect"); }
  async alarm() {
    let next = Infinity;
    for (const socket of this.state.getWebSockets()) {
      const expires = socket.deserializeAttachment()?.expires || 0;
      if (expires <= Date.now()) socket.close(1000, "Renew authentication");
      else next = Math.min(next, expires);
    }
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next);
  }
}
