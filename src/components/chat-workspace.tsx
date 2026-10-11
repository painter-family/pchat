"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signOutOfApp } from "@/app/auth/actions";
import type { ChatMessage, ChatSummary, ChatUser } from "@/lib/chat-types";

const button = "rounded-xl border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50";

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed. Try again.");
  return data as T;
}

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

export function ChatWorkspace({ user, initialChats, selectedId }: {
  user: ChatUser; initialChats: ChatSummary[]; selectedId?: string;
}) {
  const router = useRouter();
  const [chats, setChats] = useState(initialChats);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<{ chats: ChatSummary[] }>("/api/chats", { signal: controller.signal });
        setChats(data.chats);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to refresh chats.");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [user.id]);

  async function createChat() {
    setCreating(true);
    try {
      const result = await api<{ id: string }>("/api/chats", { method: "POST" });
      router.push(`/chat/${result.id}`);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to create chat."); }
    finally { setCreating(false); }
  }

  const selected = chats.find((chat) => chat.id === selectedId) || initialChats.find((chat) => chat.id === selectedId);
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background sm:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-foreground/10 bg-foreground/[0.025] sm:w-72 sm:border-r sm:border-b-0" aria-label="Chat navigation">
        <div className="flex items-center justify-between p-4">
          <Link href="/" className="text-2xl font-semibold tracking-tight">pchat</Link>
          <button className={button} onClick={createChat} disabled={creating}>{creating ? "Creating…" : "New chat"}</button>
        </div>
        <nav aria-label="Active chats" className="flex max-h-40 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 sm:max-h-none">
          {chats.length === 0 && <p className="p-3 text-sm text-foreground/60">Your conversations will appear here.</p>}
          {chats.map((chat) => (
            <Link key={chat.id} href={`/chat/${chat.id}`} aria-current={selectedId === chat.id ? "page" : undefined}
              className={`rounded-xl p-3 ${selectedId === chat.id ? "bg-teal-700 text-white" : "hover:bg-foreground/5"}`}>
              <span className="block truncate font-medium">{chat.title}</span>
              <span className={`mt-1 block truncate text-xs ${selectedId === chat.id ? "text-white/75" : "text-foreground/60"}`}>{chat.lastMessage}</span>
            </Link>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-foreground/10 p-4">
          <p className="min-w-0 truncate text-sm" title={user.email}>{user.name}</p>
          <form action={signOutOfApp}><button className={button} type="submit">Sign out</button></form>
        </div>
        {error && <p className="px-4 pb-4 text-sm text-red-600" role="alert">{error} <Link href="/" className="underline">Return home</Link></p>}
      </aside>
      {selectedId ? <Conversation key={selectedId} chatId={selectedId} chat={selected} user={user} /> : (
        <section className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <h1 className="text-3xl font-semibold">Start a conversation</h1>
          <p className="mt-4 max-w-md text-foreground/60">Create a chat, share its invitation link, and exchange messages, images, and videos with a friend.</p>
          <button className={`${button} mt-6`} onClick={createChat} disabled={creating}>New chat</button>
        </section>
      )}
    </main>
  );
}

function Conversation({ chatId, chat, user }: { chatId: string; chat?: ChatSummary; user: ChatUser }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [moreHistory, setMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [invitation, setInvitation] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const retryKey = useRef<string | null>(null);
  const newest = messages.at(-1)?.id;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let first = true;
    async function poll() {
      try {
        const data = await api<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages${cursor ? `?after=${cursor}` : ""}`, { signal: controller.signal });
        if (first) { setMoreHistory(data.messages.length === 100); first = false; }
        if (data.messages.length) cursor = data.messages.at(-1)!.id;
        setMessages((previous) => mergeMessages(previous, data.messages));
        setLoaded(true);
        setConnectionError("");
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : "Unable to load messages.");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId]);

  useLayoutEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [newest]);

  async function invite() {
    setInviting(true);
    setError("");
    try {
      const { token } = await api<{ token: string }>(`/api/chats/${chatId}/invite`, { method: "POST" });
      setInvitation(`${window.location.origin}/invite/${token}`);
      setCopied(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to create an invitation."); }
    finally { setInviting(false); }
  }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(invitation); setCopied(true); }
    catch { setError("Select and copy the invitation link below."); }
  }

  async function loadOlder() {
    if (!messages.length) return;
    setHistoryLoading(true);
    try {
      const height = scroll.current?.scrollHeight || 0;
      const top = scroll.current?.scrollTop || 0;
      const data = await api<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages?before=${messages[0].id}`);
      nearBottom.current = false;
      setMessages((previous) => mergeMessages(data.messages, previous));
      setMoreHistory(data.messages.length === 100);
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = top + scroll.current.scrollHeight - height; });
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to load older messages."); }
    finally { setHistoryLoading(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || !loaded || (!text.trim() && !file)) return;
    setSending(true);
    setError("");
    const form = new FormData();
    retryKey.current ||= crypto.randomUUID();
    form.set("clientKey", retryKey.current);
    form.set("text", text);
    if (file) form.set("file", file);
    try {
      await api(`/api/chats/${chatId}/messages`, { method: "POST", body: form });
      setText(""); setFile(null); retryKey.current = null;
      if (input.current) input.current.value = "";
      nearBottom.current = true;
    } catch (error) { setError(error instanceof Error ? error.message : "Message was not sent. Try again."); }
    finally { setSending(false); }
  }

  const canSend = loaded && !sending && Boolean(text.trim() || file);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Conversation">
      <header className="border-b border-foreground/10 px-5 py-4">
        <h1 className="text-xl font-semibold">{chat?.title || "Conversation"}</h1>
        <p className="mt-1 text-xs text-foreground/60">{chat?.joined ? "Private conversation · updates every 2 seconds" : "Invite a friend to join this chat"}</p>
        {!chat?.joined && <button className={`${button} mt-3`} onClick={invite} disabled={inviting}>{inviting ? "Creating link…" : "Get invitation link"}</button>}
        {invitation && !chat?.joined && <div className="mt-3 flex flex-wrap items-center gap-2">
          <input aria-label="Invitation link" readOnly value={invitation} className="min-w-0 flex-1 rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm" onFocus={(event) => event.target.select()} />
          <button className={button} onClick={copyInvite}>{copied ? "Copied" : "Copy link"}</button>
          <p className="w-full text-xs text-foreground/60">Valid for 7 days. The first friend to join becomes the second participant. Creating another link replaces this one.</p>
        </div>}
      </header>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Chat messages" onScroll={() => {
        const el = scroll.current;
        if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}>
        {moreHistory && <div className="mb-4 text-center"><button className={button} onClick={loadOlder} disabled={historyLoading}>{historyLoading ? "Loading…" : "Load older messages"}</button></div>}
        {!loaded && !connectionError && <p role="status" className="text-foreground/60">Loading messages…</p>}
        {loaded && !messages.length && <p className="text-foreground/60">Say hello. Messages and uploads will stay in this conversation.</p>}
        <ol className="space-y-4">
          {messages.map((message) => <li key={message.id} className={`flex ${message.senderId === user.id ? "justify-end" : "justify-start"}`}>
            <article className={`max-w-[90%] rounded-2xl px-4 py-3 sm:max-w-[75%] ${message.senderId === user.id ? "bg-teal-700 text-white" : "bg-foreground/5"}`}>
              <p className="mb-1 text-xs font-medium opacity-75">{message.senderId === user.id ? "You" : message.senderName}</p>
              {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
              {message.attachment && <div className="mt-2">
                {message.attachment.mime.startsWith("image/") ? <Image src={`/api/media/${message.attachment.id}`} alt={message.attachment.name} width={640} height={480} unoptimized className="h-auto max-h-80 w-auto max-w-full rounded-lg object-contain" /> :
                  <video src={`/api/media/${message.attachment.id}`} controls preload="metadata" className="max-h-80 max-w-full rounded-lg" aria-label={message.attachment.name} />}
                <a className="mt-2 block break-all text-xs underline" href={`/api/media/${message.attachment.id}`} target="_blank" rel="noopener noreferrer">{message.attachment.name}</a>
              </div>}
              <time dateTime={new Date(message.createdAt).toISOString()} className="mt-2 block text-[11px] opacity-65">{new Date(message.createdAt).toLocaleString()}</time>
            </article>
          </li>)}
        </ol>
      </div>
      {(error || connectionError) && <p className="px-5 py-2 text-sm text-red-600" role="alert">{error || connectionError} {connectionError && <Link href="/" className="underline">Return home</Link>}</p>}
      <form onSubmit={send} className="border-t border-foreground/10 p-4">
        <label htmlFor="message" className="sr-only">Message</label>
        <textarea id="message" value={text} maxLength={10000} rows={2} disabled={sending} placeholder="Write a message…" aria-describedby="message-keyboard-hint" className="w-full resize-none rounded-xl border border-foreground/20 bg-background p-3" onChange={(event) => { setText(event.target.value); retryKey.current = null; }} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend && !event.repeat) event.currentTarget.form?.requestSubmit();
          }
        }} />
        <p id="message-keyboard-hint" className="mt-1 text-xs text-foreground/60">Enter to send · Shift+Enter for a new line</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className={`${button} cursor-pointer`}>Attach image or video
            <input ref={input} aria-label="Attach image or video" type="file" className="sr-only" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm" disabled={sending} onChange={(event) => {
              const chosen = event.target.files?.[0] || null;
              if (chosen && chosen.size > 25 * 1024 * 1024) { setError("The attachment exceeds 25 MB."); event.target.value = ""; return; }
              setFile(chosen); setError(""); retryKey.current = null;
            }} />
          </label>
          <span className="text-xs text-foreground/60">Up to 25 MB</span>
          <button type="submit" disabled={!canSend} className={`${button} ml-auto bg-teal-700 text-white hover:bg-teal-800`}>{sending ? "Sending…" : "Send"}</button>
        </div>
        {file && <div className="mt-2 flex items-center gap-3 text-sm"><span className="min-w-0 truncate">{file.name}</span><button type="button" className="underline" disabled={sending} onClick={() => { setFile(null); if (input.current) input.current.value = ""; retryKey.current = null; }}>Remove</button></div>}
      </form>
    </section>
  );
}
