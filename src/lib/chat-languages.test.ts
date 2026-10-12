// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatStore } from "./chat-store";
import { UserSessions } from "./user-sessions";
import { ChatLanguages } from "./chat-languages";

let store: ChatStore;
let sessions: UserSessions;
const alice = { id: "alice", name: "Alice", email: "alice@example.com" };
const bob = { id: "bob", name: "Bob", email: "bob@example.com" };
beforeEach(() => { vi.stubEnv("AUTH_SECRET", "language-test"); store = new ChatStore(":memory:"); sessions = new UserSessions(store.db); });
afterEach(() => { store.db.close(); vi.unstubAllEnvs(); });

test("Spanish originals survive English translation, cache reuse, previews and reading preference changes", async () => {
  const chat = store.createChat(alice); store.joinChat(chat.token, bob);
  const result = store.sendMessage(chat.id, alice, "Hola, ¿cómo estás?", "spanish", undefined, "es");
  const translate = vi.fn(async () => "Hi, how are you?");
  const languages = new ChatLanguages(sessions, translate);
  expect(await languages.preferred(bob.id)).toBe("en");
  expect((await languages.decorate(store.messages(chat.id, bob.id), bob.id))[0].translation?.status).toBe("pending");
  expect((await languages.request(chat.id, bob.id, [result.id]))[0]).toMatchObject({ text: "Hola, ¿cómo estás?", sourceLanguage: "es", translation: { status: "ready", text: "Hi, how are you?" } });
  await languages.request(chat.id, bob.id, [result.id], true);
  expect(translate).toHaveBeenCalledTimes(1);
  expect((await languages.summaries(store.listChats(bob.id), bob.id))[0].lastMessage).toBe("Hi, how are you?");
  expect((await languages.decorate(store.messages(chat.id, alice.id), alice.id))[0].translation).toBeUndefined();
  await languages.setPreferred(bob, "es");
  expect(await new ChatLanguages(new UserSessions(store.db)).preferred(bob.id)).toBe("es");
  expect((await languages.decorate(store.messages(chat.id, bob.id), bob.id))[0].translation).toBeUndefined();
  expect(store.messages(chat.id, bob.id)[0].text).toBe("Hola, ¿cómo estás?");
});

test("concurrent devices claim one translation, failed translations require retry, and outsiders cannot invoke AI", async () => {
  const chat = store.createChat(alice); store.joinChat(chat.token, bob);
  const result = store.sendMessage(chat.id, alice, "Hola", "spanish", undefined, "es");
  let release!: (text: string) => void;
  const translate = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const languages = new ChatLanguages(sessions, translate);
  const first = languages.request(chat.id, bob.id, [result.id]);
  await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
  expect((await languages.request(chat.id, bob.id, [result.id]))[0].translation?.status).toBe("pending");
  release("Hello"); await first;
  await expect(languages.request(chat.id, "outsider", [result.id])).rejects.toThrow("Chat not found");
  expect(translate).toHaveBeenCalledTimes(1);
  const second = store.sendMessage(chat.id, alice, "Adiós", "second", undefined, "es");
  const failing = vi.fn(async () => { throw new Error("Provider unavailable"); });
  const failures = new ChatLanguages(sessions, failing);
  expect((await failures.request(chat.id, bob.id, [second.id]))[0].translation?.status).toBe("failed");
  await failures.request(chat.id, bob.id, [second.id]); expect(failing).toHaveBeenCalledTimes(1);
  const retry = new ChatLanguages(sessions, async () => "Goodbye");
  expect((await retry.request(chat.id, bob.id, [second.id], true))[0].translation?.text).toBe("Goodbye");
});

test("writing language follows the shared draft revision and interrupted leases can resume", async () => {
  const chat = store.createChat(alice); store.joinChat(chat.token, bob);
  const initial = await sessions.updateChatView(chat.id, alice.id, 0, { draft: "Hola" });
  const spanish = await sessions.updateChatView(chat.id, alice.id, initial.revision, { inputLanguage: "es" });
  expect(spanish.draftRevision).toBe(initial.draftRevision + 1);
  expect(await new UserSessions(store.db).chatView(chat.id, alice.id)).toMatchObject({ inputLanguage: "es", draft: "Hola" });
  await expect(sessions.updateChatView(chat.id, alice.id, initial.revision, { inputLanguage: "en" })).rejects.toThrow("another device");
  const result = store.sendMessage(chat.id, alice, "Hola", "spanish", undefined, "es");
  store.db.prepare("INSERT INTO message_translations VALUES(?,? ,NULL,'pending','interrupted',?)").run(result.id, "en", Date.now() - 121000);
  const translate = vi.fn(async () => "Hello");
  expect((await new ChatLanguages(sessions, translate).request(chat.id, bob.id, [result.id]))[0].translation?.status).toBe("ready");
  expect(translate).toHaveBeenCalledOnce();
});


test("linking legacy Google logins keeps the saved reading and writing languages", async () => {
  const first = store.createChat({ ...alice, id: "old-a" });
  const legacy = { ...alice, id: "old-b" };
  store.joinChat(first.token, legacy);
  await new ChatLanguages(sessions).setPreferred(legacy, "es");
  await sessions.updateChatView(first.id, legacy.id, 0, { inputLanguage: "es" });
  const canonical = await sessions.googleAccount("linked-subject", { ...alice, verified: true });
  expect(canonical).toBe("old-a");
  expect(await new ChatLanguages(sessions).preferred(canonical)).toBe("es");
  expect(await sessions.chatView(first.id, canonical)).toMatchObject({ inputLanguage: "es" });
});
