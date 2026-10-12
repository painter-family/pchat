"use client";
import { useEffect } from "react";
import { api, refreshConnections } from "@/lib/chat-client";

export function useLiveUpdates(userId: string) {
  useEffect(() => {
    const controller = new AbortController();
    let connection: WebSocket | EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let heartbeat: ReturnType<typeof setInterval>;
    let failures = 0;
    let connecting = false;
    function reconnect() {
      clearInterval(heartbeat);
      if (!controller.signal.aborted) retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
    }
    async function connect() {
      if (connecting || controller.signal.aborted) return;
      connecting = true;
      try {
        const data = await api<{ kind: string; ticket?: string }>("/api/live-ticket", { method: "POST", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (data.kind === "sse") {
          if (typeof EventSource === "undefined") return;
          const source = new EventSource("/api/events"); connection = source;
          source.onopen = () => { failures = 0; refreshConnections(); };
          source.onmessage = refreshConnections;
          source.onerror = () => { source.close(); reconnect(); };
        } else if (data.ticket) {
          const url = new URL("/api/live", window.location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const socket = new WebSocket(url, ["pchat.v1", "ticket." + data.ticket]); connection = socket;
          socket.onopen = () => {
            failures = 0; refreshConnections();
            heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send("ping"); }, 20000);
          };
          socket.onmessage = event => { if (event.data !== "pong") refreshConnections(); };
          socket.onclose = reconnect;
          socket.onerror = () => socket.close();
        }
      } catch { reconnect(); }
      finally { connecting = false; }
    }
    const resume = () => {
      if (document.visibilityState === "visible") {
        refreshConnections();
        if (!connection || connection.readyState >= 2) { clearTimeout(retry); void connect(); }
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    void connect();
    return () => {
      controller.abort(); clearTimeout(retry); clearInterval(heartbeat); connection?.close();
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume);
    };
  }, [userId]);
}
