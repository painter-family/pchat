// @vitest-environment node
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { ChatStore } from "./chat-store";
import { UserSessions } from "./user-sessions";
import { mintLiveTicket, verifyLiveTicket } from "./live-ticket";

let store: ChatStore;
let sessions: UserSessions;
const alice = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob = { id: "bob", name: "Bob", email: "bob@example.com" };
beforeEach(() => { vi.stubEnv("AUTH_SECRET", "unit-session-secret"); store = new ChatStore(":memory:"); sessions = new UserSessions(store.db); });
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); });

test("Google logins recover and merge legacy accounts while old cookies remain usable", async () => {
  const first = store.createChat({ ...alice, id: "old-a" });
  const second = store.createChat({ ...alice, id: "old-b" });
  store.joinChat(first.token, { ...alice, id: "old-b" });
  store.sendMessage(first.id, { ...alice, id: "old-b" }, "Existing history", "same-key");
  await sessions.selectChat({ ...alice, id: "old-b" }, second.id);
  await sessions.updateChatView(second.id, "old-b", 0, { draft: "iPad draft" });
  const profile = { email: alice.email, name: alice.name, verified: true };
  const id = await sessions.googleAccount("google-subject", profile);
  expect(id).toBe("old-a");
  expect(await new UserSessions(store.db).googleAccount("google-subject", profile)).toBe(id);
  expect(await sessions.canonicalId("old-b")).toBe(id);
  expect(store.listChats(id)).toHaveLength(2);
  expect(store.messages(first.id, id)[0].senderId).toBe(id);
  expect(await sessions.userView(id)).toMatchObject({ selectedChatId: second.id });
  expect(await sessions.chatView(second.id, id)).toMatchObject({ draft: "iPad draft" });
  expect(store.joinChat(first.token, bob)).toBe(first.id);
  await expect(sessions.googleAccount("unverified", { ...profile, verified: false })).rejects.toThrow("verified Google");
  const other = await sessions.googleAccount("different-subject", profile);
  expect(other).not.toBe(id);
  expect(store.listChats(other)).toEqual([]);
});

test("views persist across connections, reject stale drafts, and keep sent drafts cleared after scroll updates", async () => {
  const chat = store.createChat(alice);
  const message = store.sendMessage(chat.id, alice, "History", "history");
  await sessions.selectChat(alice, chat.id);
  const saved = await sessions.updateChatView(chat.id, alice.id, 0, { draft: "Shared text", anchorId: message.id, anchorOffset: 0.4 });
  const ipad = new UserSessions(store.db);
  expect(await ipad.chatView(chat.id, alice.id)).toEqual(saved);
  await expect(ipad.updateChatView(chat.id, alice.id, 0, { draft: "Stale text" })).rejects.toThrow("another device");
  const scrolled = await ipad.updateChatView(chat.id, alice.id, saved.revision, { anchorOffset: 0.8 });
  expect(scrolled.draftRevision).toBe(saved.draftRevision);
  await sessions.clearSentDraft(chat.id, alice.id, saved.draftRevision, "Shared text");
  expect((await ipad.chatView(chat.id, alice.id)).draft).toBe("");
  await expect(ipad.chatView(chat.id, bob.id)).rejects.toThrow("not found");
  await expect(ipad.selectChat(bob, chat.id)).rejects.toThrow("not found");
  await expect(ipad.updateChatView(chat.id, alice.id, scrolled.revision + 1, { anchorId: 123456 })).rejects.toThrow("reading position");
});

test("each chat has a different key and separate connections retrieve the same invitation", () => {
  const first = store.createChat(alice);
  const second = store.createChat(alice);
  expect(first.token).not.toBe(second.token);
  expect(store.refreshInvite(first.id, alice.id)).toBe(first.token);
  expect(store.currentInvite(first.id, alice.id)).toBe(first.token);
  expect(store.currentInvite(second.id, alice.id)).toBe(second.token);
});

test("WebSocket tickets are authenticated, scoped to one user, and expire", async () => {
  const ticket = await mintLiveTicket(alice.id, "ticket-secret");
  expect(await verifyLiveTicket(ticket, "ticket-secret")).toBe(alice.id);
  expect(await verifyLiveTicket(ticket, "wrong-secret")).toBeNull();
  expect(await verifyLiveTicket(ticket + "tampered", "ticket-secret")).toBeNull();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
  expect(await verifyLiveTicket(ticket, "ticket-secret")).toBeNull();
  vi.restoreAllMocks();
});
