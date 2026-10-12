import { connection } from "next/server";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { currentChatUser } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";
import { Welcome } from "./welcome";
import { ChatWorkspace } from "./chat-workspace";
import { redirect } from "next/navigation";
import { userSessions } from "@/lib/user-sessions";

export async function AccountPanel() {
  // Evaluate account state and runtime credentials separately for every request.
  await connection();
  const configured = isGoogleAuthConfigured();
  const user = await currentChatUser();
  if (!user) return <Welcome configured={configured} />;
  const view = await (await userSessions()).userView(user.id);
  if (view.selectedChatId) redirect(`/chat/${view.selectedChatId}`);
  return <ChatWorkspace user={user} initialChats={await (await chatStore()).listChats(user.id)} />;
}
