import { auth } from "@/auth";
import { isGoogleAuthConfigured } from "./auth-config";
import { ChatError, isChatError } from "./chat-store";
import type { ChatUser } from "./chat-types";

export async function currentChatUser(): Promise<ChatUser | null> {
  if (!isGoogleAuthConfigured()) return null;
  const session = await auth();
  if (!session?.user?.id) return null;
  return { id: session.user.id, name: session.user.name || session.user.email || "Google user", email: session.user.email || "" };
}

export function requireSameOrigin(request: Request) {
  const expected = new URL(process.env.AUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== expected) throw new ChatError("Request origin is not allowed.", 403);
}

export async function chatApi(request: Request, mutate: boolean, run: (user: ChatUser) => Promise<Response> | Response) {
  try {
    const user = await currentChatUser();
    if (!user) throw new ChatError("Sign in to continue.", 401);
    if (mutate) requireSameOrigin(request);
    const response = await run(user);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (!isChatError(error)) console.error("Chat request failed", error);
    return Response.json({ error: isChatError(error) ? error.message : "The request could not be completed. Try again." },
      { status: isChatError(error) ? error.status : 500, headers: { "Cache-Control": "no-store" } });
  }
}
