import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { currentChatUser } from "@/lib/chat-api";
import { isChatError, chatStore } from "@/lib/chat-store";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { Welcome } from "@/components/welcome";
import { ChatWorkspace } from "@/components/chat-workspace";

async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const user = await currentChatUser();
  if (!user) return <Welcome configured={isGoogleAuthConfigured()} returnTo={`/chat/${id}`} />;
  const store = chatStore();
  try { store.requireMember(id, user.id); }
  catch (error) { if (isChatError(error)) notFound(); throw error; }
  return <ChatWorkspace user={user} initialChats={store.listChats(user.id)} selectedId={id} />;
}

export default function ChatPage(props: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<p className="p-8" role="status">Loading conversation…</p>}><Conversation {...props} /></Suspense>;
}
