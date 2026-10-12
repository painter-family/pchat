// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import type { CloudStorage } from "./cloudflare-storage";
import { D1ChatStore } from "./d1-chat-store";
import { auth } from "@/auth";
import { POST as send } from "@/app/api/chats/[id]/messages/route";
import { GET as readMedia } from "@/app/api/media/[id]/route";
import { ChatLanguages } from "./chat-languages";
import { POST as translateMessages } from "@/app/api/chats/[id]/translations/route";
import { UserSessions } from "./user-sessions";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("./cloudflare-storage", () => ({ storageBackend: () => "cloudflare", cloudStorage: async () => proxy.env }));
vi.mock("./chat-store", async (original) => ({ ...await original<typeof import("./chat-store")>(), chatStore: async () => store }));

let proxy: PlatformProxy<CloudStorage>;
let store: D1ChatStore;
let directory: string;
const alice = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob = { id: "bob", name: "Bob", email: "bob@example.com" };
const eve = { id: "eve", name: "Eve", email: "eve@example.com" };
const base = "http://localhost:3000";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "pchat-d1-"));
  const configPath = path.join(directory, "wrangler.json");
  writeFileSync(configPath, JSON.stringify({ name: "pchat-test", compatibility_date: "2026-10-10",
    d1_databases: [{ binding: "DB", database_name: "test-db", database_id: "test-db" }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "test-media" }] }));
  proxy = await getPlatformProxy<CloudStorage>({ configPath, remoteBindings: false, persist: false, envFiles: [] });
  const sql = readdirSync("migrations").sort().map(name => readFileSync("migrations/" + name, "utf8")).join("\n").replace(/--[^\n]*/g, "");
  await proxy.env.DB.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => proxy.env.DB.prepare(statement)));
  store = new D1ChatStore(proxy.env.DB);
}, 30000);
beforeEach(async () => {
  await proxy.env.DB.batch(["message_translations", "user_preferences", "chat_views", "user_views", "user_aliases", "google_accounts", "attachments", "messages", "members", "chats", "users"].map((table) => proxy.env.DB.prepare(`DELETE FROM ${table}`)));
  vi.stubEnv("AUTH_URL", base);
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-google-secret");
  vi.mocked(auth).mockResolvedValue({ user: alice, expires: "2099-01-01" } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
afterAll(async () => { await proxy?.dispose(); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("concurrent invitation claims admit only one friend", async () => {
  const chat = await store.createChat(alice);
  const claims = await Promise.allSettled([store.joinChat(chat.token, bob), store.joinChat(chat.token, eve)]);
  expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
  const winner = claims[0].status === "fulfilled" ? bob : eve;
  expect(await store.joinChat(chat.token, winner)).toBe(chat.id);
  expect((await store.listChats(alice.id))[0].title).toBe(winner.name);
  expect(await store.db.prepare("SELECT COUNT(*) AS count FROM members WHERE chat_id=?").bind(chat.id).first("count")).toBe(2);
});

test("expired invitations are renewed without replacing their chat key", async () => {
  const chat = await store.createChat(alice);
  await store.db.prepare("UPDATE chats SET invite_expires=0 WHERE id=?").bind(chat.id).run();
  await expect(store.joinChat(chat.token, bob)).rejects.toThrow("expired");
  const replacement = await store.refreshInvite(chat.id, alice.id);
  expect(replacement).toBe(chat.token);
  await store.joinChat(replacement, bob);
  await expect(store.refreshInvite(chat.id, bob.id)).rejects.toThrow("Only the chat creator");
  await expect(store.refreshInvite(chat.id, alice.id)).rejects.toThrow("two participants");
});

test("concurrent message retries save one message and keep the winner's attachment", async () => {
  const chat = await store.createChat(alice);
  const files = ["first", "second"].map((id) => ({ id, name: "photo.png", mime: "image/png", size: 67, storageName: id + ".png" }));
  const results = await Promise.all(files.map((file) => store.sendMessage(chat.id, alice, file.id, "same-key", file)));
  expect(results.filter((result) => result.inserted)).toHaveLength(1);
  expect(results[0].id).toBe(results[1].id);
  const messages = await store.messages(chat.id, alice.id);
  expect(messages).toHaveLength(1);
  const winner = results.findIndex((result) => result.inserted);
  expect(messages[0].attachment?.id).toBe(files[winner].id);
  await expect(store.attachment(files[1 - winner].id, alice.id)).rejects.toThrow("not found");
});

test("attachment errors roll back the entire message batch", async () => {
  const chat = await store.createChat(alice);
  const file = { id: "duplicate", name: "photo.png", mime: "image/png", size: 67, storageName: "same.png" };
  await store.sendMessage(chat.id, alice, "First", "first", file);
  await expect(store.sendMessage(chat.id, alice, "Rejected", "second", file)).rejects.toThrow();
  expect((await store.messages(chat.id, alice.id)).map((message) => message.text)).toEqual(["First"]);
  await expect(store.sendMessage(chat.id, eve, "Outsider", "third")).rejects.toThrow("Chat not found");
});

test("history cursors and each participant's chat list survive reopening the adapter", async () => {
  const chat = await store.createChat(alice);
  await store.joinChat(chat.token, bob);
  const first = await store.sendMessage(chat.id, alice, "Hello", "a1");
  const second = await store.sendMessage(chat.id, bob, "Reply", "b1");
  const reopened = new D1ChatStore(proxy.env.DB);
  expect((await reopened.messages(chat.id, alice.id, { after: first.id })).map((message) => message.id)).toEqual([second.id]);
  expect((await reopened.messages(chat.id, bob.id, { before: second.id })).map((message) => message.id)).toEqual([first.id]);
  expect((await reopened.listChats(bob.id))[0].title).toBe("Alice");
  expect(await reopened.listChats(eve.id)).toEqual([]);
});

test("D1 shares views across sessions and atomically rejects stale draft writers", async () => {
  const chat = await store.createChat(alice);
  const sessions = new UserSessions(proxy.env.DB);
  await sessions.selectChat(alice, chat.id);
  const attempts = await Promise.allSettled([
    sessions.updateChatView(chat.id, alice.id, 0, { draft: "Laptop" }),
    new UserSessions(proxy.env.DB).updateChatView(chat.id, alice.id, 0, { draft: "iPad" }),
  ]);
  expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
  const view = await sessions.chatView(chat.id, alice.id);
  expect(["Laptop", "iPad"]).toContain(view.draft);
  expect(view.revision).toBe(1);
  expect((await sessions.userView(alice.id)).selectedChatId).toBe(chat.id);
});

test("D1 maps repeated Google logins to the same legacy account and keeps history", async () => {
  const chat = await store.createChat(alice);
  const second = { ...alice, id: "alice-device-two" };
  await store.joinChat(chat.token, second);
  await store.sendMessage(chat.id, second, "Saved on another device", "device-two");
  const sessions = new UserSessions(proxy.env.DB);
  const profile = { email: alice.email, name: alice.name, verified: true };
  const ids = await Promise.all([sessions.googleAccount("subject", profile), sessions.googleAccount("subject", profile)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await sessions.canonicalId(second.id)).toBe(ids[0]);
  expect((await store.messages(chat.id, ids[0]))[0].senderId).toBe(ids[0]);
  expect(await sessions.memberIds(chat.id)).toEqual([ids[0]]);
});

test("R2 uploads remain private, support video ranges, and clean up duplicate uploads", async () => {
  const chat = await store.createChat(alice);
  await store.joinChat(chat.token, bob);
  async function upload(key: string, bytes: Buffer, name: string) {
    const body = new FormData(); body.set("text", "Media"); body.set("clientKey", key);
    body.set("file", new File([new Uint8Array(bytes)], name));
    return send(new Request(base + `/api/chats/${chat.id}/messages`, { method: "POST", headers: { Origin: base }, body }), { params: Promise.resolve({ id: chat.id }) });
  }
  expect((await upload("photo", png, "photo.png")).status).toBe(201);
  const before = (await proxy.env.MEDIA.list()).objects.length;
  expect((await upload("photo", png, "retry.png")).status).toBe(200);
  expect((await proxy.env.MEDIA.list()).objects).toHaveLength(before);
  const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
  expect((await upload("video", mp4, "clip.mp4")).status).toBe(201);
  const messages = await store.messages(chat.id, alice.id);
  const photo = messages[0].attachment!;
  const video = messages[1].attachment!;
  vi.mocked(auth).mockResolvedValue({ user: bob, expires: "2099-01-01" } as never);
  const media = await readMedia(new Request(base + `/api/media/${photo.id}`), { params: Promise.resolve({ id: photo.id }) });
  expect(Buffer.from(await media.arrayBuffer())).toEqual(png);
  const range = await readMedia(new Request(base + `/api/media/${video.id}`, { headers: { Range: "bytes=0-7" } }), { params: Promise.resolve({ id: video.id }) });
  expect(range.status).toBe(206);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(mp4.subarray(0, 8));
  const invalid = await readMedia(new Request(base + `/api/media/${video.id}`, { headers: { Range: "bytes=999-" } }), { params: Promise.resolve({ id: video.id }) });
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("content-range")).toBe(`bytes */${mp4.length}`);
  vi.mocked(auth).mockResolvedValue({ user: eve, expires: "2099-01-01" } as never);
  expect((await readMedia(new Request(base + `/api/media/${photo.id}`), { params: Promise.resolve({ id: photo.id }) })).status).toBe(404);
  expect((await upload("outsider", png, "no.png")).status).toBe(404);
  expect((await proxy.env.MEDIA.list()).objects).toHaveLength(before + 1);
}, 15000);

test("D1 language settings and translation leases synchronize devices while keeping original messages private", async () => {
  const chat = await store.createChat(alice); await store.joinChat(chat.token, bob);
  const sessions = new UserSessions(proxy.env.DB);
  await sessions.updateChatView(chat.id, alice.id, 0, { inputLanguage: "es", draft: "Hola" });
  expect(await new UserSessions(proxy.env.DB).chatView(chat.id, alice.id)).toMatchObject({ inputLanguage: "es", draft: "Hola" });
  const message = await store.sendMessage(chat.id, alice, "Hola", "language-test", undefined, "es");
  const translate = vi.fn(async () => "Hello");
  const languages = new ChatLanguages(sessions, translate);
  await Promise.all([languages.request(chat.id, bob.id, [message.id]), new ChatLanguages(new UserSessions(proxy.env.DB), translate).request(chat.id, bob.id, [message.id])]);
  expect(translate).toHaveBeenCalledOnce();
  expect((await languages.decorate(await store.messages(chat.id, bob.id), bob.id))[0]).toMatchObject({ text: "Hola", sourceLanguage: "es", translation: { text: "Hello", status: "ready" } });
  await languages.setPreferred(bob, "es");
  expect(await new ChatLanguages(new UserSessions(proxy.env.DB)).preferred(bob.id)).toBe("es");
  await expect(languages.request(chat.id, eve.id, [message.id])).rejects.toThrow("Chat not found");
  vi.mocked(auth).mockResolvedValue({ user: eve, expires: "2099-01-01" } as never);
  const request = () => new Request(`${base}/api/chats/${chat.id}/translations`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [message.id] }) });
  expect((await translateMessages(request(), { params: Promise.resolve({ id: chat.id }) })).status).toBe(404);
  expect((await store.messages(chat.id, bob.id))[0].text).toBe("Hola");
});
