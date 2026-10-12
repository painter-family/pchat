import { createHmac } from "node:crypto";

export function chatInvitationKey(chatId: string) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is required for chat invitations.");
  return createHmac("sha256", process.env.AUTH_SECRET).update(`pchat:invitation:v1:${chatId}`).digest("base64url");
}
