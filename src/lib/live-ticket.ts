const encoder = new TextEncoder();
function pack(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function unpack(value: string) { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)); }
async function key(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function mintLiveTicket(userId: string, secret: string) {
  const body = pack(encoder.encode(JSON.stringify({ userId, expires: Date.now() + 30000 })));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode("pchat-live:" + body));
  return body + "." + pack(new Uint8Array(signature));
}
export async function verifyLiveTicket(ticket: string, secret: string): Promise<string | null> {
  try {
    if (!secret || ticket.length > 1500) return null;
    const [body, signature, extra] = ticket.split(".");
    if (!body || !signature || extra || !await crypto.subtle.verify("HMAC", await key(secret), unpack(signature), encoder.encode("pchat-live:" + body))) return null;
    const data = JSON.parse(new TextDecoder().decode(unpack(body)));
    return typeof data.userId === "string" && data.userId.length <= 200 && data.expires > Date.now() && data.expires <= Date.now() + 30000 ? data.userId : null;
  } catch { return null; }
}
