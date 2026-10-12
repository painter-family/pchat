export class ChatRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new ChatRequestError(data.error || "The request failed. Try again.", response.status);
  return data as T;
}
export function refreshConnections() { window.dispatchEvent(new Event("pchat:invalidate")); }
export async function flushDrafts() {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent("pchat:flush", { detail: pending }));
  await Promise.all(pending);
}
