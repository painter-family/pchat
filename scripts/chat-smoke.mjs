import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { encode } from "next-auth/jwt";
import { JSDOM } from "jsdom";

// Uses an isolated database, signing key, and test sessions. It never reads Google credentials.
assert.ok(existsSync(".next/BUILD_ID"), "Run npm run build before this HTTP check.");
const directory = mkdtempSync(path.join(os.tmpdir(), "pchat-http-"));
const port = 3107;
const base = `http://localhost:${port}`;
const secret = randomBytes(48).toString("base64url");
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port)], {
  env: { ...process.env, AUTH_URL: base, AUTH_SECRET: secret,
    AUTH_GOOGLE_ID: "http-test.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "http-test-only",
    PCHAT_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
});
let serverError;
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
server.on("error", (error) => { serverError = error; });

async function cookie(id, name) {
  const token = await encode({ secret, salt: "authjs.session-token", token: { sub: id, name, email: `${id}@example.com` } });
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
  for (let i = 0; i < 80; i++) {
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
  assert.equal(created.status, 201);
  const { id, token } = await created.json();
  const anonymousInvite = await request(`/invite/${token}`);
  assert.ok((await anonymousInvite.text()).includes("Sign in with Google"));
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
  console.log("HTTP chat checks passed: invitations, two participants, both message directions, private image/video uploads, byte ranges, saved history and sidebar pages.");
} catch (error) {
  console.error(serverLog.replaceAll(secret, "[redacted]"));
  throw error;
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), sleep(3000)]);
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
