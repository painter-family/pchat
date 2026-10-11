// @vitest-environment node
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "./chat-store";
import { auth } from "@/auth";
import { GET as listChats, POST as createChat } from "@/app/api/chats/route";
import { GET as readMessages, POST as send } from "@/app/api/chats/[id]/messages/route";
import { GET as readMedia } from "@/app/api/media/[id]/route";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("./chat-store", async (original) => {
  const imported = await original<typeof import("./chat-store")>();
  return { ...imported, chatStore: () => store };
});
let store: ChatStore;
let directory: string;
const user = { id: "alice", name: "Alice", email: "alice@example.com" };
const base = "http://localhost:3000";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
beforeEach(() => {
  store = new ChatStore(":memory:");
  directory = mkdtempSync(path.join(os.tmpdir(), "pchat-upload-"));
  vi.stubEnv("PCHAT_DATA_DIR", directory);
  vi.stubEnv("PCHAT_STORAGE", "local");
  vi.stubEnv("AUTH_URL", base);
  vi.stubEnv("AUTH_SECRET", "unit-test-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", "unit-test-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "unit-test-client-secret");
  vi.mocked(auth).mockResolvedValue({ user, expires: "2099-01-01" } as never);
});
afterEach(() => { store.db.close(); rmSync(directory, { recursive: true }); vi.unstubAllEnvs(); vi.clearAllMocks(); });

test("anonymous API access is rejected and cross-origin writes cannot create chats", async () => {
  vi.mocked(auth).mockResolvedValue(null as never);
  expect((await listChats(new Request(base + "/api/chats"))).status).toBe(401);
  vi.mocked(auth).mockResolvedValue({ user, expires: "2099-01-01" } as never);
  expect((await createChat(new Request(base + "/api/chats", { method: "POST", headers: { Origin: "https://elsewhere.example" } }))).status).toBe(403);
  expect(store.listChats(user.id)).toEqual([]);
});

test("a photo is saved with its message, delivered privately, and supports byte-range reads", async () => {
  const { id } = store.createChat(user);
  const form = new FormData();
  form.set("text", "A photo"); form.set("clientKey", "photo-message");
  form.set("file", new File([png], "photo.png", { type: "image/png" }));
  const response = await send(new Request(base + `/api/chats/${id}/messages`, { method: "POST", headers: { Origin: base }, body: form }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(201);
  const messages = await readMessages(new Request(base + `/api/chats/${id}/messages`), { params: Promise.resolve({ id }) });
  const attachment = (await messages.json()).messages[0].attachment;
  const media = await readMedia(new Request(base + `/api/media/${attachment.id}`), { params: Promise.resolve({ id: attachment.id }) });
  expect(media.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await media.arrayBuffer())).toEqual(png);
  const range = await readMedia(new Request(base + `/api/media/${attachment.id}`, { headers: { Range: "bytes=0-7" } }), { params: Promise.resolve({ id: attachment.id }) });
  expect(range.status).toBe(206);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(0, 8));
  vi.mocked(auth).mockResolvedValue({ user: { id: "eve" }, expires: "2099-01-01" } as never);
  expect((await readMedia(new Request(base + `/api/media/${attachment.id}`), { params: Promise.resolve({ id: attachment.id }) })).status).toBe(404);
});

test("HTML disguised as an image and oversized requests are rejected without adding messages", async () => {
  const { id } = store.createChat(user);
  const form = new FormData(); form.set("text", ""); form.set("clientKey", "bad-file");
  form.set("file", new File(["<script>alert(1)</script>"], "fake.png", { type: "image/png" }));
  expect((await send(new Request(base + `/api/chats/${id}/messages`, { method: "POST", headers: { Origin: base }, body: form }), { params: Promise.resolve({ id }) })).status).toBe(400);
  expect((await send(new Request(base + `/api/chats/${id}/messages`, { method: "POST", headers: { Origin: base, "Content-Length": "999999999" }, body: "too large" }), { params: Promise.resolve({ id }) })).status).toBe(413);
  expect(store.messages(id, user.id)).toEqual([]);
});
