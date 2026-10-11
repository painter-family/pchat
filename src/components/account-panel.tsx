import { connection } from "next/server";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { currentChatUser } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";
import { Welcome } from "./welcome";
import { ChatWorkspace } from "./chat-workspace";

export async function AccountPanel() {
  // Evaluate account state and runtime credentials separately for every request.
  await connection();
  const configured = isGoogleAuthConfigured();
  const user = await currentChatUser();
  if (!user) return <Welcome configured={configured} />;
  return <ChatWorkspace user={user} initialChats={chatStore().listChats(user.id)} />;
}
