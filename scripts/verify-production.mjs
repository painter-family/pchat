import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { encode } from "next-auth/jwt";
import { JSDOM } from "jsdom";

const config = JSON.parse(readFileSync("wrangler.d1.json", "utf8"));
const base = config.env.production.vars.AUTH_URL;
assert.equal(base, "https://painter-family.info");
const request = (route, options = {}) => fetch(base + route, {
  redirect: "manual", signal: AbortSignal.timeout(15000), ...options,
});
assert.equal((await request("/api/chats")).status, 401);
const home = await request("/");
assert.equal(home.status, 200);
const dom = new JSDOM(await home.text());
const google = [...dom.window.document.querySelectorAll("button")].find(el => el.textContent.includes("Sign in with Google"));
assert.ok(google && !google.disabled, "Production Google sign-in must be enabled.");
const stylesheet = dom.window.document.querySelector('link[rel="stylesheet"]')?.getAttribute("href");
assert.ok(stylesheet?.startsWith("/_next/static/"));
assert.equal((await request(stylesheet)).status, 200);
dom.window.close();
const csrf = await request("/api/auth/csrf");
assert.equal(csrf.status, 200);
const { csrfToken } = await csrf.json();
const cookies = csrf.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const signIn = await request("/api/auth/signin/google", {
  method: "POST",
  headers: { Cookie: cookies, Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken, callbackUrl: base }),
});
assert.equal(signIn.status, 302);
const authorization = new URL(signIn.headers.get("location"));
assert.equal(authorization.hostname, "accounts.google.com");
assert.equal(authorization.searchParams.get("redirect_uri"), base + "/api/auth/callback/google");
console.log("Production HTTPS, assets, private routes, and Google authorization redirect passed.");

if (existsSync(".env.production.local")) {
  const secrets = parseEnv(readFileSync(".env.production.local", "utf8"));
  assert.equal(authorization.searchParams.get("client_id"), secrets.AUTH_GOOGLE_ID);
  const cookieName = "__Secure-authjs.session-token";
  const token = await encode({ secret: secrets.AUTH_SECRET, salt: cookieName,
    token: { sub: "deployment-check-" + randomUUID(), name: "Deployment check", email: "deployment-check@example.invalid" } });
  const response = await request("/api/chats", { headers: { Cookie: `${cookieName}=${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chats: [] });
  console.log("Production session secret and authenticated D1 read passed; no chat data was written.");
}
