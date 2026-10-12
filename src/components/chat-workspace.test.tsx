import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatSummary } from "@/lib/chat-types";
import { ChatWorkspace } from "./chat-workspace";

const { push, router } = vi.hoisted(() => { const push = vi.fn(); return { push, router: { push, replace: vi.fn() } }; });
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/auth/actions", () => ({ signOutOfApp: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("sidebar selects saved chats and the composer sends text with an attachment", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "Hi Alice" }];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: "chat-1", revision: 1 });
    if (url.endsWith("/view")) return Response.json({ draft: "", draftRevision: 1, anchorId: null, anchorOffset: 0, revision: 1 });
    if (options?.method === "POST") return Response.json({ id: 2 }, { status: 201 });
    if (url === "/api/chats") return Response.json({ chats });
    return Response.json({ messages: [{ id: 1, chatId: "chat-1", senderId: "bob", senderName: "Bob", text: "Hi Alice", createdAt: 1, attachment: null }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await screen.findByText("Hi Alice", { selector: "p" });
  const chatLink = screen.getByRole("link", { name: "Bob Hi Alice" });
  expect(chatLink.getAttribute("href")).toBe("/chat/chat-1");
  expect(chatLink.getAttribute("aria-current")).toBe("page");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello Bob" } });
  const file = new File(["fixture"], "photo.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Attach image or video"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith("/messages") && options?.method === "POST")).toBe(true));
  const [url, options] = fetchMock.mock.calls.find(([url, options]) => url.endsWith("/messages") && options?.method === "POST")!;
  expect(url).toBe("/api/chats/chat-1/messages");
  expect((options!.body as FormData).get("text")).toBe("Hello Bob");
  expect((options!.body as FormData).get("file")).toBe(file);
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""));
});

test("creating a chat navigates to its conversation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (_url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (_url === "/api/view") return Response.json({ selectedChatId: null, revision: 0 });
    return Response.json(options?.method === "POST" ? { id: "new-chat" } : { chats: [] });
  }));
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={[]} />);
  fireEvent.click(screen.getAllByRole("button", { name: "New chat" })[0]);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/new-chat"));
});

test("Enter submits through the composer while Shift+Enter and IME confirmation do not send", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "" }];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: "chat-1", revision: 1 });
    if (url.endsWith("/view")) return Response.json({ draft: "", draftRevision: 1, anchorId: null, anchorOffset: 0, revision: 1 });
    if (options?.method === "POST") return Response.json({ id: 1 }, { status: 201 });
    return Response.json(url === "/api/chats" ? { chats } : { messages: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await screen.findByText("Say hello. Messages and uploads will stay in this conversation.");
  const input = screen.getByLabelText("Message");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith("/messages") && options?.method === "POST")).toBe(false);
  fireEvent.change(input, { target: { value: "Hello with Enter" } });
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(fetchMock.mock.calls.some(([url, options]) => url.endsWith("/messages") && options?.method === "POST")).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  const requests = fetchMock.mock.calls.filter(([url, options]) => url.endsWith("/messages") && options?.method === "POST");
  expect(requests).toHaveLength(1);
  expect((requests[0][1]!.body as FormData).get("text")).toBe("Hello with Enter");
});

test("two rendered connections restore a saved draft and update each other after edits and sends", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, owned: true, updatedAt: 1, lastMessage: "History" }];
  let view = { draft: "Saved on my laptop", draftRevision: 1, revision: 1, anchorId: null, anchorOffset: 0 };
  const messages = [{ id: 1, chatId: "chat-1", senderId: "alice", senderName: "Alice", text: "History", createdAt: 1, attachment: null }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: "chat-1", revision: 1 });
    if (url === "/api/chats") return Response.json({ chats });
    if (url.endsWith("/view")) {
      if (options?.method === "PATCH") {
        const body = JSON.parse(options.body as string);
        if (body.revision !== view.revision) return Response.json({ error: "Changed on another device" }, { status: 409 });
        view = { ...view, draft: body.draft ?? view.draft, revision: view.revision + 1, draftRevision: view.draftRevision + 1 };
      }
      return Response.json(view);
    }
    if (options?.method === "POST") {
      const text = (options.body as FormData).get("text") as string;
      messages.push({ ...messages[0], id: 2, text });
      view = { ...view, draft: "", revision: view.revision + 1, draftRevision: view.draftRevision + 1 };
      return Response.json({ id: 2 }, { status: 201 });
    }
    return Response.json({ messages });
  }));
  const user = { id: "alice", name: "Alice", email: "alice@example.com" };
  const laptop = render(<ChatWorkspace user={user} initialChats={chats} selectedId="chat-1" />);
  const ipad = render(<ChatWorkspace user={user} initialChats={chats} selectedId="chat-1" />);
  const laptopInput = within(laptop.container).getByRole("textbox") as HTMLTextAreaElement;
  const ipadInput = within(ipad.container).getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => { expect(laptopInput.value).toBe(view.draft); expect(ipadInput.value).toBe(view.draft); });
  fireEvent.change(laptopInput, { target: { value: "Typed on the laptop" } });
  await waitFor(() => expect(ipadInput.value).toBe("Typed on the laptop"));
  fireEvent.click(within(ipad.container).getByRole("button", { name: "Send" }));
  await waitFor(() => { expect(laptopInput.value).toBe(""); expect(ipadInput.value).toBe(""); });
  expect(await within(laptop.container).findByText("Typed on the laptop", { selector: "p" })).toBeTruthy();
});

test("an edit from another device after an uncertain send gets a new message key", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "" }];
  let view = { draft: "First draft", draftRevision: 1, revision: 1, anchorId: null, anchorOffset: 0 };
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: "chat-1", revision: 1 });
    if (url === "/api/chats") return Response.json({ chats });
    if (url.endsWith("/view")) return Response.json(view);
    if (options?.method === "POST") {
      keys.push((options.body as FormData).get("clientKey") as string);
      if (keys.length === 1) return Response.json({ error: "Try again" }, { status: 500 });
      view = { ...view, draft: "", draftRevision: 3, revision: 3 };
      return Response.json({ id: 2 }, { status: 201 });
    }
    return Response.json({ messages: [] });
  }));
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Try again");
  view = { ...view, draft: "Changed on my iPad", draftRevision: 2, revision: 2 };
  act(() => window.dispatchEvent(new Event("pchat:invalidate")));
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(view.draft));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[0]).not.toBe(keys[1]);
});

test("a conversation switch from another device saves the pending local draft before navigation", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "" }];
  let selected = "chat-1";
  let view = { draft: "", draftRevision: 0, revision: 0, anchorId: null, anchorOffset: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: selected, revision: 1 });
    if (url === "/api/chats") return Response.json({ chats });
    if (url.endsWith("/view")) {
      if (options?.method === "PATCH") view = { ...view, ...JSON.parse(options.body as string), revision: view.revision + 1, draftRevision: view.draftRevision + 1 };
      return Response.json(view);
    }
    return Response.json({ messages: [] });
  }));
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await screen.findByText("Say hello. Messages and uploads will stay in this conversation.");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep this unfinished draft" } });
  selected = "chat-2";
  act(() => window.dispatchEvent(new Event("pchat:invalidate")));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/chat-2"));
  expect(view.draft).toBe("Keep this unfinished draft");
});

test("conversation menus save Spanish without navigation and translated messages reveal their original", async () => {
  const chats: ChatSummary[] = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "Hello", inputLanguage: "en" }];
  let view = { draft: "", draftRevision: 1, anchorId: null, anchorOffset: 0, revision: 1, inputLanguage: "en" };
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/live-ticket") return Response.json({ kind: "none" });
    if (url === "/api/view") return Response.json({ selectedChatId: "chat-1", revision: 1, preferredLanguage: "en" });
    if (url === "/api/chats") return Response.json({ chats });
    if (url.endsWith("/view")) {
      if (options?.method === "PATCH") {
        const patch = JSON.parse(options.body as string);
        view = { ...view, inputLanguage: patch.inputLanguage, revision: view.revision + 1 };
        chats[0].inputLanguage = patch.inputLanguage;
      }
      return Response.json(view);
    }
    return Response.json({ messages: [{ id: 1, chatId: "chat-1", senderId: "bob", senderName: "Bob", text: "Hola", sourceLanguage: "es", createdAt: 1, attachment: null, translation: { status: "ready", targetLanguage: "en", text: "Hello" } }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await screen.findByText("Hello", { selector: "p" });
  expect((screen.getByLabelText("Reading language") as HTMLSelectElement).value).toBe("en");
  fireEvent.click(screen.getByRole("button", { name: "Show original" }));
  expect(screen.getByText("Hola", { selector: "p" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show translation" }));
  const options = screen.getByLabelText("Options for Bob");
  fireEvent.click(options);
  expect(screen.getByRole("button", { name: /Download conversation/ }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Writing language for Bob"), { target: { value: "es" } });
  await screen.findByText("Writing in Español");
  expect(push).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).lang).toBe("es");
});
