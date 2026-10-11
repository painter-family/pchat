"use server";

import { redirect } from "next/navigation";
import { currentChatUser } from "@/lib/chat-api";
import { isChatError, chatStore } from "@/lib/chat-store";

export async function joinInvitation(token: string) {
  if (!/^[\w-]{43}$/.test(token)) redirect("/");
  const user = await currentChatUser();
  if (!user) redirect(`/invite/${token}`);
  let id;
  try { id = chatStore().joinChat(token, user); }
  catch (error) { if (isChatError(error)) redirect(`/invite/${token}`); throw error; }
  redirect(`/chat/${id}`);
}
