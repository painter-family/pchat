"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signOutOfApp } from "@/app/auth/actions";
import type { ChatMessage, ChatSummary, ChatUser, ChatView, UserView } from "@/lib/chat-types";

import { api, ChatRequestError, refreshConnections, flushDrafts } from "@/lib/chat-client";
import { useLiveUpdates } from "./use-live-updates";

const button = "rounded-xl border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50";

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.id - b.id);
}

export function ChatWorkspace({ user, initialChats, selectedId }: {
  user: ChatUser; initialChats: ChatSummary[]; selectedId?: string;
}) {
  const router = useRouter();
  const [viewer, setViewer] = useState(user);
  useLiveUpdates(viewer.id);
  const [chats, setChats] = useState(initialChats);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    let again = false;
    async function poll() {
      if (busy) { again = true; return; }
      busy = true;
      clearTimeout(timer);
      try {
        const [data, view] = await Promise.all([
          api<{ chats: ChatSummary[] }>("/api/chats", { signal: controller.signal }),
          api<UserView & { user: ChatUser }>("/api/view", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setChats(data.chats);
        if (view.user) setViewer(view.user);
        if (view.selectedChatId && view.selectedChatId !== selectedId) {
          await flushDrafts(); router.replace(`/chat/${view.selectedChatId}`);
        } else if (!view.selectedChatId && selectedId && view.revision > 0) {
          await flushDrafts(); router.replace("/");
        }
        else if (!view.selectedChatId && selectedId && view.revision === 0) await chooseChat(selectedId, true);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to refresh chats.");
      } finally {
        busy = false;
        if (!controller.signal.aborted) { timer = setTimeout(poll, again ? 0 : 15000); again = false; }
      }
    }
    async function chooseChat(id: string, initialize: boolean) {
      await api("/api/view", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedChatId: id, initialize }) });
    }
    const update = () => { void poll(); };
    window.addEventListener("pchat:invalidate", update);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("pchat:invalidate", update); };
  }, [user.id, selectedId, router]);

  async function selectChat(id: string | null) {
    try {
      await flushDrafts();
      await api("/api/view", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedChatId: id }) });
      router.push(id ? `/chat/${id}` : "/");
      refreshConnections();
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to select chat."); }
  }

  async function createChat() {
    setCreating(true);
    try {
      await flushDrafts();
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
          <Link href="/" onClick={event => { event.preventDefault(); void selectChat(null); }} className="text-2xl font-semibold tracking-tight">pchat</Link>
          <button className={button} onClick={createChat} disabled={creating}>{creating ? "Creating…" : "New chat"}</button>
        </div>
        <nav aria-label="Active chats" className="flex max-h-40 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 sm:max-h-none">
          {chats.length === 0 && <p className="p-3 text-sm text-foreground/60">Your conversations will appear here.</p>}
          {chats.map((chat) => (
            <Link key={chat.id} href={`/chat/${chat.id}`} onClick={event => { event.preventDefault(); void selectChat(chat.id); }} aria-current={selectedId === chat.id ? "page" : undefined}
              className={`rounded-xl p-3 ${selectedId === chat.id ? "bg-teal-700 text-white" : "hover:bg-foreground/5"}`}>
              <span className="block truncate font-medium">{chat.title}</span>
              <span className={`mt-1 block truncate text-xs ${selectedId === chat.id ? "text-white/75" : "text-foreground/60"}`}>{chat.lastMessage}</span>
            </Link>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-foreground/10 p-4">
          <p className="min-w-0 truncate text-sm" title={viewer.email}>{viewer.name}</p>
          <form action={signOutOfApp}><button className={button} type="submit">Sign out</button></form>
        </div>
        {error && <p className="px-4 pb-4 text-sm text-red-600" role="alert">{error} <Link href="/" className="underline">Return home</Link></p>}
      </aside>
      {selectedId ? <Conversation key={`${selectedId}:${viewer.id}`} chatId={selectedId} chat={selected} user={viewer} /> : (
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
  const [draftStatus, setDraftStatus] = useState("Loading draft…");
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

  const view = useRef<ChatView>({ draft: "", draftRevision: 0, anchorId: null, anchorOffset: 0, revision: 0 });
  const draft = useRef("");
  const dirty = useRef(false);
  const writeCount = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restore = useRef<ChatView | undefined>(undefined);
  const suppressScroll = useRef(0);

  const saveView = useCallback(async (patch: Partial<ChatView>, keepalive = false) => {
    writeCount.current++;
    const task = writes.current.catch(() => {}).then(async () => {
      try {
        const result = await api<ChatView>(`/api/chats/${chatId}/view`, { method: "PATCH", keepalive, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...patch, revision: view.current.revision }) });
        view.current = result;
        if (patch.draft !== undefined && draft.current === patch.draft) { dirty.current = false; setDraftStatus("Draft saved"); }
        return result;
      } catch (error) {
        if (error instanceof ChatRequestError && error.status === 409) {
          const latest = await api<ChatView>(`/api/chats/${chatId}/view`);
          view.current = latest; draft.current = latest.draft; dirty.current = false;
          retryKey.current = null;
          clearTimeout(draftTimer.current); setText(latest.draft); restore.current = latest;
          setDraftStatus("Latest saved draft restored");
        }
        else if (patch.draft !== undefined) setDraftStatus("Draft not saved");
        setError(error instanceof Error ? error.message : "Unable to save view.");
        throw error;
      } finally { writeCount.current--; refreshConnections(); }
    });
    writes.current = task;
    return task;
  }, [chatId]);
  function editDraft(value: string) {
    draft.current = value; dirty.current = true; setText(value); retryKey.current = null;
    setDraftStatus("Saving draft…");
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void saveView({ draft: draft.current }).catch(() => {}); }, 350);
  }
  const flushDraft = useCallback(async () => {
    clearTimeout(draftTimer.current);
    await writes.current.catch(() => {});
    if (dirty.current) await saveView({ draft: draft.current });
  }, [saveView]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let oldest = 0;
    let first = true;
    let busy = false;
    let again = false;
    async function poll() {
      if (busy) { again = true; return; }
      busy = true; clearTimeout(timer);
      try {
        const saved = await api<ChatView & { inviteToken?: string }>(`/api/chats/${chatId}/view`, { signal: controller.signal });
        if (saved.inviteToken) setInvitation(`${window.location.origin}/invite/${saved.inviteToken}`);
        else if ("inviteToken" in saved) setInvitation("");
        if (!dirty.current && !writeCount.current && saved.revision >= view.current.revision) {
          if (saved.draftRevision !== view.current.draftRevision || saved.draft !== draft.current) retryKey.current = null;
          if (first || saved.anchorId !== view.current.anchorId || saved.anchorOffset !== view.current.anchorOffset) restore.current = saved;
          view.current = saved; draft.current = saved.draft; setText(saved.draft); setDraftStatus("Draft saved");
        }
        let data = await api<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages${cursor ? `?after=${cursor}` : ""}`, { signal: controller.signal });
        const incoming = [...data.messages];
        if (data.messages.length) cursor = data.messages.at(-1)!.id;
        if (first) { oldest = data.messages[0]?.id || 0; setMoreHistory(data.messages.length === 100); }
        while (data.messages.length === 100 && !first) {
          data = await api<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages?after=${cursor}`, { signal: controller.signal });
          incoming.push(...data.messages);
          if (data.messages.length) cursor = data.messages.at(-1)!.id;
        }
        const anchor = restore.current?.anchorId;
        while (anchor && oldest && anchor < oldest) {
          const older = await api<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages?before=${oldest}`, { signal: controller.signal });
          if (!older.messages.length) break;
          incoming.push(...older.messages); oldest = older.messages[0].id;
          setMoreHistory(older.messages.length === 100);
        }
        if (controller.signal.aborted) return;
        setMessages(previous => mergeMessages(previous, incoming));
        first = false; setLoaded(true); setConnectionError("");
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : "Unable to load messages.");
      } finally {
        busy = false;
        if (!controller.signal.aborted) { timer = setTimeout(poll, again ? 0 : 15000); again = false; }
      }
    }
    const update = () => { void poll(); };
    const flush = (event: Event) => { (event as CustomEvent<Promise<unknown>[]>).detail.push(flushDraft()); };
    const saveBeforeLeaving = () => {
      if (!dirty.current || writeCount.current) return;
      // Browser keepalive allows the final small text edit to finish on handoff.
      clearTimeout(draftTimer.current);
      void saveView({ draft: draft.current }, true).catch(() => {});
    };
    const hidden = () => { if (document.visibilityState === "hidden") saveBeforeLeaving(); };
    window.addEventListener("pchat:invalidate", update);
    window.addEventListener("pchat:flush", flush);
    window.addEventListener("pagehide", saveBeforeLeaving);
    document.addEventListener("visibilitychange", hidden);
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer); clearTimeout(draftTimer.current); clearTimeout(scrollTimer.current);
      window.removeEventListener("pchat:invalidate", update);
      window.removeEventListener("pchat:flush", flush);
      window.removeEventListener("pagehide", saveBeforeLeaving);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [chatId, flushDraft, saveView]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const saved = restore.current;
    if (saved) {
      suppressScroll.current = Date.now() + 200;
      if (saved.anchorId === null) { element.scrollTop = element.scrollHeight; nearBottom.current = true; }
      else {
        const message = element.querySelector<HTMLElement>(`[data-message-id="${saved.anchorId}"]`);
        if (message) {
          element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top + saved.anchorOffset * message.offsetHeight;
          nearBottom.current = false;
        }
      }
      restore.current = undefined;
    } else if (nearBottom.current) { suppressScroll.current = Date.now() + 200; element.scrollTop = element.scrollHeight; }
  }, [newest, messages]);

  function recordPosition() {
    const element = scroll.current;
    if (!element || !loaded || Date.now() < suppressScroll.current) return;
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    const top = element.getBoundingClientRect().top;
    const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => node.getBoundingClientRect().bottom > top);
    const anchorId = nearBottom.current || !message ? null : Number(message.dataset.messageId);
    const anchorOffset = !message || anchorId === null ? 0 : Math.max(0, Math.min(1, (top - message.getBoundingClientRect().top) / (message.offsetHeight || 1)));
    if (anchorId === view.current.anchorId && Math.abs(anchorOffset - view.current.anchorOffset) < 0.02) return;
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { void saveView({ anchorId, anchorOffset }).catch(() => {}); }, 350);
  }

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
    try { await flushDraft(); } catch { setSending(false); return; }
    retryKey.current ||= file ? crypto.randomUUID() : `draft-${chatId}-${view.current.draftRevision}`;
    form.set("draftRevision", String(view.current.draftRevision));
    form.set("clientKey", retryKey.current);
    form.set("text", text);
    if (file) form.set("file", file);
    try {
      await api(`/api/chats/${chatId}/messages`, { method: "POST", body: form });
      dirty.current = false; draft.current = ""; setText(""); setFile(null); retryKey.current = null;
      refreshConnections();
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
        <p className="mt-1 text-xs text-foreground/60">{chat?.joined ? "Private conversation · live updates" : "Invite a friend to join this chat"}</p>
        {!chat?.joined && chat?.owned !== false && <button className={`${button} mt-3`} onClick={invite} disabled={inviting}>{inviting ? "Creating link…" : "Get invitation link"}</button>}
        {invitation && !chat?.joined && <div className="mt-3 flex flex-wrap items-center gap-2">
          <input aria-label="Invitation link" readOnly value={invitation} className="min-w-0 flex-1 rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm" onFocus={(event) => event.target.select()} />
          <button className={button} onClick={copyInvite}>{copied ? "Copied" : "Copy link"}</button>
          <p className="w-full text-xs text-foreground/60">Valid for 7 days. The first friend to join becomes the second participant. This link belongs to the chat and is the same on every device. Renewing it extends its validity.</p>
        </div>}
      </header>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Chat messages" onScroll={recordPosition}>        {moreHistory && <div className="mb-4 text-center"><button className={button} onClick={loadOlder} disabled={historyLoading}>{historyLoading ? "Loading…" : "Load older messages"}</button></div>}
        {!loaded && !connectionError && <p role="status" className="text-foreground/60">Loading messages…</p>}
        {loaded && !messages.length && <p className="text-foreground/60">Say hello. Messages and uploads will stay in this conversation.</p>}
        <ol className="space-y-4">
          {messages.map((message) => <li key={message.id} data-message-id={message.id} className={`flex ${message.senderId === user.id ? "justify-end" : "justify-start"}`}>
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
        <textarea id="message" value={text} maxLength={10000} rows={2} disabled={sending || !loaded} placeholder="Write a message…" aria-describedby="message-keyboard-hint" className="w-full resize-none rounded-xl border border-foreground/20 bg-background p-3" onChange={(event) => editDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend && !event.repeat) event.currentTarget.form?.requestSubmit();
          }
        }} />
        <p id="message-keyboard-hint" className="mt-1 text-xs text-foreground/60">Enter to send · Shift+Enter for a new line</p>
        <p className="mt-1 text-xs text-foreground/60" aria-live="polite">{draftStatus}</p>
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
