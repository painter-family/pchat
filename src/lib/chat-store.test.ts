// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore, INVITE_TTL } from "./chat-store";

const alice = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob = { id: "bob", name: "Bob", email: "bob@example.com" };
const eve = { id: "eve", name: "Eve", email: "eve@example.com" };
let store: ChatStore;
beforeEach(() => { vi.stubEnv("AUTH_SECRET", "unit-test-invitation-secret"); store = new ChatStore(":memory:"); });
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); });

test("invitation admits exactly one friend and remains usable by existing members", () => {
  const chat = store.createChat(alice);
  expect(store.joinChat(chat.token, alice)).toBe(chat.id);
  expect(store.listChats(alice.id)[0].joined).toBe(false);
  expect(store.joinChat(chat.token, bob)).toBe(chat.id);
  expect(store.joinChat(chat.token, bob)).toBe(chat.id);
  expect(() => store.joinChat(chat.token, eve)).toThrow("already been used");
  expect(store.listChats(alice.id)[0].title).toBe("Bob");
  expect(store.listChats(bob.id)[0].title).toBe("Alice");
  expect(store.listChats(eve.id)).toEqual([]);
});

test("expired links require renewal with the same chat-specific key", () => {
  const chat = store.createChat(alice);
  store.db.prepare("UPDATE chats SET invite_expires=? WHERE id=?").run(Date.now() - INVITE_TTL, chat.id);
  expect(() => store.joinChat(chat.token, bob)).toThrow("expired");
  const replacement = store.refreshInvite(chat.id, alice.id);
  expect(replacement).toBe(chat.token);
  expect(store.joinChat(replacement, bob)).toBe(chat.id);
  expect(() => store.refreshInvite(chat.id, alice.id)).toThrow("two participants");
});

test("participants exchange messages while outsiders cannot read, write, or retrieve media", () => {
  const chat = store.createChat(alice);
  store.joinChat(chat.token, bob);
  const attachment = { id: "media1", name: "photo.png", mime: "image/png", size: 67, storageName: "media1.png" };
  store.sendMessage(chat.id, alice, "Hello Bob", "a1");
  store.sendMessage(chat.id, bob, "Hi Alice", "b1", attachment);
  const messages = store.messages(chat.id, alice.id);
  expect(messages.map((m) => m.text)).toEqual(["Hello Bob", "Hi Alice"]);
  expect(store.messages(chat.id, bob.id)).toEqual(messages);
  expect(messages[1].attachment?.id).toBe("media1");
  expect(store.attachment("media1", alice.id)).toEqual(attachment);
  expect(() => store.messages(chat.id, eve.id)).toThrow("Chat not found");
  expect(() => store.sendMessage(chat.id, eve, "intrusion", "e1")).toThrow("Chat not found");
  expect(() => store.attachment("media1", eve.id)).toThrow("Attachment not found");
});

test("message retries are deduplicated and history cursors preserve chronological order", () => {
  const { id } = store.createChat(alice);
  const first = store.sendMessage(id, alice, "First", "once");
  expect(store.sendMessage(id, alice, "First", "once")).toEqual({ id: first.id, inserted: false });
  for (let i = 0; i < 105; i++) store.sendMessage(id, alice, `message ${i}`, `msg-${i}`);
  const latest = store.messages(id, alice.id);
  expect(latest).toHaveLength(100);
  expect(store.messages(id, alice.id, { before: latest[0].id })).toHaveLength(6);
  expect(store.messages(id, alice.id, { after: first.id })).toHaveLength(100);
  expect(latest.at(-1)?.text).toBe("message 104");
});

test("chat history and media metadata survive reopening the database", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pchat-persistence-"));
  const filename = path.join(directory, "chat.sqlite");
  const persistent = new ChatStore(filename);
  const { id, token } = persistent.createChat(alice);
  persistent.joinChat(token, bob);
  persistent.sendMessage(id, bob, "Saved video", "video1", { id: "video", name: "movie.mp4", mime: "video/mp4", size: 123, storageName: "video.mp4" });
  persistent.db.close();
  const reopened = new ChatStore(filename);
  try {
    expect(reopened.listChats(alice.id)).toHaveLength(1);
    expect(reopened.messages(id, alice.id)[0].attachment?.mime).toBe("video/mp4");
    expect(reopened.attachment("video", bob.id).storageName).toBe("video.mp4");
  } finally { reopened.db.close(); rmSync(directory, { recursive: true }); }
});
