import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { currentChatUser } from "@/lib/chat-api";
import { isChatError, chatStore } from "@/lib/chat-store";
import { isGoogleAuthConfigured } from "@/lib/auth-config";
import { Welcome } from "@/components/welcome";
import { joinInvitation } from "../actions";

async function Invitation({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const user = await currentChatUser();
  if (!user) return <Welcome configured={isGoogleAuthConfigured()} returnTo={`/invite/${token}`} invitation />;
  let invite;
  let errorMessage;
  try { invite = await (await chatStore()).invitation(token, user.id); }
  catch (error) { if (!isChatError(error)) throw error; errorMessage = error.message; }
  if (invite?.joined) redirect(`/chat/${invite.id}`);
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">{invite ? `Chat with ${invite.name}` : "Invitation unavailable"}</h1>
      <p className="mt-4 text-foreground/70">{errorMessage || "Join this private conversation to exchange messages, photos, and videos."}</p>
      {invite && <form action={joinInvitation.bind(null, token)}><button className="mt-6 rounded-xl bg-teal-700 px-5 py-3 font-medium text-white" type="submit">Join chat</button></form>}
      <Link className="mt-6 underline underline-offset-4" href="/">Back to pchat</Link>
    </main>
  );
}

export default function InvitePage(props: { params: Promise<{ token: string }> }) {
  return <Suspense fallback={<p className="p-8" role="status">Loading invitation…</p>}><Invitation {...props} /></Suspense>;
}
