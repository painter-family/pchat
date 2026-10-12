import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

type Listener = () => void;
const global = globalThis as typeof globalThis & { pchatListeners?: Map<string, Set<Listener>> };
export function subscribeUser(userId: string, listener: Listener) {
  const map = global.pchatListeners ||= new Map();
  const listeners = map.get(userId) || new Set();
  listeners.add(listener); map.set(userId, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) map.delete(userId); };
}
export async function notifyUsers(ids: string[]) {
  try {
    if (process.env.PCHAT_RUNTIME === "worker") {
      const hub = (getCloudflareContext().env as unknown as { USER_CONNECTIONS: DurableObjectNamespace }).USER_CONNECTIONS;
      await Promise.all([...new Set(ids)].map(id => hub.get(hub.idFromName(id)).fetch("https://internal/notify", { method: "POST" })));
    } else for (const id of new Set(ids)) for (const listener of global.pchatListeners?.get(id) || []) listener();
  } catch { console.error("Live notification failed; clients will catch up on reconnect or polling."); }
}
