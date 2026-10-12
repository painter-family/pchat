import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { encode } from "next-auth/jwt";
import { JSDOM } from "jsdom";
import WebSocket from "ws";

// Uses test sessions, never Google credentials. Cloud mode writes only development
// resources with unique probe users and removes those users/chats/objects afterward.
const cloud = process.argv.includes("--cloudflare");
const worker = process.argv.includes("--worker");
assert.ok(!(cloud && worker), "Choose cloud development or isolated Worker preview.");
if (worker) assert.ok(existsSync(".open-next/worker.js"), "Run npm run build:worker first.");
else if (!cloud) assert.ok(existsSync(".next/BUILD_ID"), "Run npm run build before this HTTP check.");
const directory = mkdtempSync(path.join(os.tmpdir(), "pchat-http-"));
const port = 3107;
const base = `http://localhost:${port}`;
const secret = randomBytes(48).toString("base64url");
const probe = "pchat-probe-" + randomUUID();
const actorId = (name) => `${probe}-${name}`;
let serverArgs = ["node_modules/next/dist/bin/next", cloud ? "dev" : "start", "--port", String(port)];
if (worker) {
  const config = JSON.parse(readFileSync("wrangler.preview.json", "utf8"));
  config.main = path.resolve(config.main);
  config.assets.directory = path.resolve(config.assets.directory);
  delete config.$schema;
  Object.assign(config.vars, { AUTH_SECRET: secret, AUTH_GOOGLE_ID: "http-test.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "http-test-only" });
  const configFile = path.join(directory, "wrangler.json");
  writeFileSync(configFile, JSON.stringify(config));
  const common = ["--config", configFile, "--persist-to", path.join(directory, "state")];
  const cli = path.resolve("node_modules/wrangler/bin/wrangler.js");
  const schemaFile = path.join(directory, "schema.sql");
  writeFileSync(schemaFile, readdirSync("migrations").sort().map(name => readFileSync(path.join("migrations", name), "utf8")).join("\n"));
  const migration = spawnSync(process.execPath, [cli, "d1", "execute", "pchat-preview", "--local", "--file", schemaFile, ...common], { encoding: "utf8" });
  assert.equal(migration.status, 0, migration.stderr);
  serverArgs = [cli, "dev", "--local", "--port", String(port), ...common];
}
const server = spawn(process.execPath, serverArgs, {
  env: { ...process.env, AUTH_URL: base, AUTH_SECRET: secret,
    AUTH_GOOGLE_ID: "http-test.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "http-test-only",
    PCHAT_STORAGE: cloud ? "cloudflare" : "local", PCHAT_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
});
let serverError;
let serverLog = "";
const sockets = [];
server.stdout.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
server.on("error", (error) => { serverError = error; });

async function cookie(id, name) {
  const token = await encode({ secret, salt: "authjs.session-token", token: { sub: actorId(id), name, email: `${id}@example.com` } });
  return `authjs.session-token=${token}`;
}
async function request(url, cookieValue, options = {}) {
  return fetch(base + url, { redirect: "manual", ...options,
    headers: { Cookie: cookieValue || "", Origin: base, ...options.headers } });
}
async function submitJoin(html, token, cookieValue) {
  const dom = new JSDOM(html);
  const form = [...dom.window.document.querySelectorAll("form")].find((form) => form.textContent.includes("Join chat"));
  assert.ok(form, "Invitation should provide a join form.");
  const body = new FormData();
  for (const input of form.querySelectorAll("input[name]")) body.append(input.name, input.value);
  dom.window.close();
  return request(`/invite/${token}`, cookieValue, { method: "POST", body });
}
async function sendMessage(id, cookieValue, text, filename, bytes, type) {
  const body = new FormData(); body.set("text", text); body.set("clientKey", randomBytes(16).toString("hex"));
  if (filename) body.set("file", new File([bytes], filename, { type }));
  const response = await request(`/api/chats/${id}/messages`, cookieValue, { method: "POST", body });
  assert.equal(response.status, 201, await response.text());
}

try {
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (serverError || server.exitCode !== null) throw serverError || new Error("Test server exited. Ensure port 3107 is free.");
    try { ready = (await fetch(base + "/api/chats")).status === 401; } catch {}
    if (ready) break;
    await sleep(250);
  }
  assert.ok(ready, "Test server did not become ready.");
  const alice = await cookie("alice", "Alice");
  const bob = await cookie("bob", "Bob");
  const eve = await cookie("eve", "Eve");
  const created = await request("/api/chats", alice, { method: "POST" });
  assert.equal(created.status, 201, await created.clone().text());
  const { id, token } = await created.json();
  for (const owner of [alice, await cookie("alice", "Alice")]) {
    const renewed = await request(`/api/chats/${id}/invite`, owner, { method: "POST" });
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json()).token, token);
  }
  const anonymousInvite = await request(`/invite/${token}`);
  const anonymousHtml = await anonymousInvite.text();
  if (anonymousInvite.status !== 200) {
    const errorPage = new JSDOM(anonymousHtml);
    console.error([...errorPage.window.document.querySelectorAll("h1,h2")].map(el => el.textContent.trim()).join("\n"));
    errorPage.window.close();
    await sleep(500);
  }
  assert.equal(anonymousInvite.status, 200, `Anonymous invite status ${anonymousInvite.status}; location ${anonymousInvite.headers.get("location")}`);
  assert.ok(anonymousHtml.includes("Sign in with Google"), `Anonymous invitation has no Google sign-in; body starts ${anonymousHtml.slice(0, 800)}`);
  const invitation = await request(`/invite/${token}`, bob);
  const inviteHtml = await invitation.text();
  const joined = await submitJoin(inviteHtml, token, bob);
  assert.equal(joined.status, 303);
  assert.ok(joined.headers.get("location")?.endsWith(`/chat/${id}`));
  const thirdJoin = await submitJoin(inviteHtml, token, eve);
  assert.equal(thirdJoin.status, 303);
  assert.ok(thirdJoin.headers.get("location")?.endsWith(`/invite/${token}`));
  assert.equal((await request(`/api/chats/${id}/messages`, eve)).status, 404);
  assert.equal((await request(`/api/chats/${id}/messages`)).status, 401);
  await sendMessage(id, alice, "Hello Bob");
  await sendMessage(id, bob, "Hello Alice");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  await sendMessage(id, alice, "Photo", "image.png", png, "image/png");
  // MP4 container fixture checks upload storage/streaming, not codec playback.
  const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
  await sendMessage(id, bob, "Video", "video.mp4", mp4, "video/mp4");
  const history = await (await request(`/api/chats/${id}/messages`, bob)).json();
  assert.deepEqual(history.messages.map((message) => message.text), ["Hello Bob", "Hello Alice", "Photo", "Video"]);
  const photo = history.messages[2].attachment;
  assert.deepEqual(Buffer.from(await (await request(`/api/media/${photo.id}`, bob)).arrayBuffer()), png);
  assert.equal((await request(`/api/media/${photo.id}`, eve)).status, 404);
  const video = history.messages[3].attachment;
  const range = await request(`/api/media/${video.id}`, alice, { headers: { Range: "bytes=0-7" } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), mp4.subarray(0, 8));
  for (const person of [alice, bob]) {
    const list = await (await request("/api/chats", person)).json();
    assert.equal(list.chats[0].id, id);
    const page = await request(`/chat/${id}`, person);
    assert.ok((await page.text()).includes("Chat navigation"));
  }
  const aliceSecondDevice = await cookie("alice", "Alice");
  const viewRoute = `/api/chats/${id}/view`;
  const patchView = (person, body) => request(viewRoute, person, { method: "PATCH",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const firstView = await (await request(viewRoute, alice)).json();
  assert.equal(firstView.draft, "");
  const handoff = await patchView(alice, { revision: firstView.revision, draft: "Continue this on my iPad", anchorId: history.messages[1].id, anchorOffset: 0.35 });
  assert.equal(handoff.status, 200, await handoff.clone().text());
  assert.deepEqual(await (await request(viewRoute, aliceSecondDevice)).json(), await handoff.json().then(view => ({ ...view, inviteToken: token })));
  assert.equal((await patchView(aliceSecondDevice, { revision: firstView.revision, draft: "Stale device" })).status, 409);
  assert.equal((await request(viewRoute, eve)).status, 404);
  assert.equal((await (await request(viewRoute, aliceSecondDevice)).json()).inviteToken, token);

  if (worker) {
    const watch = async person => {
      const response = await request("/api/live-ticket", person, { method: "POST" });
      assert.equal(response.status, 200);
      const { ticket } = await response.json();
      const socket = new WebSocket(base.replace("http:", "ws:") + "/api/live", ["pchat.v1", "ticket." + ticket], { headers: { Origin: base } });
      sockets.push(socket);
      const watched = { socket, count: 0 };
      socket.on("message", bytes => { if (JSON.parse(bytes.toString()).type === "invalidate") watched.count++; });
      await once(socket, "open");
      return watched;
    };
    const observers = await Promise.all([watch(alice), watch(aliceSecondDevice), watch(bob), watch(eve)]);
    const waitUntil = async condition => {
      for (let i = 0; i < 100 && !condition(); i++) await sleep(50);
      assert.ok(condition(), "Connected devices did not receive their live updates.");
    };
    await waitUntil(() => observers.every(observer => observer.count > 0));
    let counts = observers.map(observer => observer.count);
    const selectResponse = await request("/api/view", alice, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedChatId: null }) });
    assert.equal(selectResponse.status, 200);
    await waitUntil(() => observers[0].count > counts[0] && observers[1].count > counts[1]);
    assert.equal((await (await request("/api/view", aliceSecondDevice)).json()).selectedChatId, null);
    assert.equal(observers[2].count, counts[2]);
    assert.equal(observers[3].count, counts[3]);
    counts = observers.map(observer => observer.count);
    const shared = await (await request(viewRoute, alice)).json();
    assert.equal((await patchView(alice, { revision: shared.revision, draft: "Live shared draft" })).status, 200);
    await waitUntil(() => observers[0].count > counts[0] && observers[1].count > counts[1]);
    assert.equal(observers[2].count, counts[2], "A peer must not receive the user's private draft updates.");
    assert.equal(observers[3].count, counts[3], "Other users must not receive notifications.");
    assert.equal((await (await request(viewRoute, aliceSecondDevice)).json()).draft, "Live shared draft");
    counts = observers.map(observer => observer.count);
    await sendMessage(id, bob, "Seen on every device");
    await waitUntil(() => observers.slice(0, 3).every((observer, i) => observer.count > counts[i]));
    assert.equal(observers[3].count, counts[3]);
    observers[0].socket.close(); await once(observers[0].socket, "close");
    counts = observers.map(observer => observer.count);
    await sendMessage(id, bob, "Other connection remains active");
    await waitUntil(() => observers[1].count > counts[1] && observers[2].count > counts[2]);
    const reconnected = await watch(alice);
    await waitUntil(() => reconnected.count > 0);
    assert.equal((await (await request(viewRoute, alice)).json()).draft, "Live shared draft");
    assert.equal((await fetch(base + "/api/live", { headers: { Origin: base } })).status, 401);
    assert.equal((await fetch(base + "/api/live", { headers: { Origin: "https://other.example" } })).status, 403);
    console.log("Multi-device checks passed: shared draft/reading position, stale-write rejection, live fanout, user isolation, independent disconnect, and reconnect catch-up.");
  }
  console.log("HTTP chat checks passed: invitations, two participants, both message directions, private image/video uploads, byte ranges, saved history and sidebar pages.");
  if (cloud || worker) assert.equal(existsSync(path.join(directory, "pchat.sqlite")), false, "Cloud mode must not create local chat storage.");
} catch (error) {
  console.error(serverLog.replaceAll(secret, "[redacted]"));
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  if (server.exitCode === null) {
    // Wrangler starts workerd children; stop the whole owned test process tree
    // before removing its Windows-locked local D1 files.
    if (worker && process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill();
    await Promise.race([once(server, "exit"), sleep(3000)]);
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  if (cloud) {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy({ configPath: "wrangler.d1.json", environment: "development", remoteBindings: true, envFiles: [] });
    try {
      const { results } = await proxy.env.DB.prepare(`SELECT a.storage_name FROM attachments a
        JOIN messages m ON m.id=a.message_id JOIN chats c ON c.id=m.chat_id WHERE c.owner_id=?`).bind(actorId("alice")).all();
      for (const row of results) await proxy.env.MEDIA.delete(row.storage_name);
      await proxy.env.DB.batch([
        proxy.env.DB.prepare("DELETE FROM chat_views WHERE user_id IN (?,?,?)").bind(actorId("alice"),actorId("bob"),actorId("eve")),
        proxy.env.DB.prepare("DELETE FROM user_views WHERE user_id IN (?,?,?)").bind(actorId("alice"),actorId("bob"),actorId("eve")),
        proxy.env.DB.prepare("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE owner_id=?))").bind(actorId("alice")),
        proxy.env.DB.prepare("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE owner_id=?)").bind(actorId("alice")),
        proxy.env.DB.prepare("DELETE FROM members WHERE chat_id IN (SELECT id FROM chats WHERE owner_id=?)").bind(actorId("alice")),
        proxy.env.DB.prepare("DELETE FROM chats WHERE owner_id=?").bind(actorId("alice")),
        proxy.env.DB.prepare("DELETE FROM users WHERE id IN (?,?,?)").bind(actorId("alice"),actorId("bob"),actorId("eve")),
      ]);
      console.log("Removed development D1/R2 probe data.");
    } finally { await proxy.dispose(); }
  }
}
