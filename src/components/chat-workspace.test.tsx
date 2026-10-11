import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkspace } from "./chat-workspace";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/auth/actions", () => ({ signOutOfApp: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("sidebar selects saved chats and the composer sends text with an attachment", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "Hi Alice" }];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
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
  await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
  const [url, options] = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(url).toBe("/api/chats/chat-1/messages");
  expect((options!.body as FormData).get("text")).toBe("Hello Bob");
  expect((options!.body as FormData).get("file")).toBe(file);
  await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""));
});

test("creating a chat navigates to its conversation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    return Response.json(options?.method === "POST" ? { id: "new-chat" } : { chats: [] });
  }));
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={[]} />);
  fireEvent.click(screen.getAllByRole("button", { name: "New chat" })[0]);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/new-chat"));
});

test("Enter submits through the composer while Shift+Enter and IME confirmation do not send", async () => {
  const chats = [{ id: "chat-1", title: "Bob", joined: true, updatedAt: 1, lastMessage: "" }];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return Response.json({ id: 1 }, { status: 201 });
    return Response.json(url === "/api/chats" ? { chats } : { messages: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ChatWorkspace user={{ id: "alice", name: "Alice", email: "alice@example.com" }} initialChats={chats} selectedId="chat-1" />);
  await screen.findByText("Say hello. Messages and uploads will stay in this conversation.");
  const input = screen.getByLabelText("Message");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  fireEvent.change(input, { target: { value: "Hello with Enter" } });
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  const requests = fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(requests).toHaveLength(1);
  expect((requests[0][1]!.body as FormData).get("text")).toBe("Hello with Enter");
});
