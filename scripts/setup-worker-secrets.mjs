import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, ".env.production.local");
const keys = ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"];
const args = process.argv.slice(2);

try {
  if (args[0] === "--prepare") {
    if (existsSync(file)) throw new Error(".env.production.local already exists; preserve its keys and edit it directly.");
    const google = args.includes("--reuse-google")
      ? parseEnv(readFileSync(path.join(root, ".env.local"), "utf8")) : {};
    const values = {
      AUTH_SECRET: randomBytes(32).toString("base64url"),
      AUTH_GOOGLE_ID: google.AUTH_GOOGLE_ID || "",
      AUTH_GOOGLE_SECRET: google.AUTH_GOOGLE_SECRET || "",
    };
    writeFileSync(file, "# Production Worker secrets. Never commit this file.\n" +
      keys.map((key) => `${key}=${JSON.stringify(values[key])}`).join("\n") + "\n",
    { flag: "wx", mode: 0o600 });
    console.log("Prepared ignored .env.production.local with a new production session key.");
    console.log("Fill any blank Google credentials before running npm run secrets:upload:prod.");
  } else if (args.length === 0) {
    const values = parseEnv(readFileSync(file, "utf8"));
    const secrets = Object.fromEntries(keys.map((key) => [key, values[key]]));
    for (const key of keys) {
      if (!secrets[key]?.trim()) throw new Error(`Fill ${key} in .env.production.local first.`);
    }
    if (secrets.AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
    if (existsSync(path.join(root, ".env.local")) &&
        parseEnv(readFileSync(path.join(root, ".env.local"), "utf8")).AUTH_SECRET === secrets.AUTH_SECRET) {
      throw new Error("Use a separate production AUTH_SECRET, not the local session key.");
    }
    console.log("Uploading three encrypted secrets to pchat-production; a missing Worker will be created as a placeholder.");
    const result = spawnSync(process.execPath, [
      path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "secret", "bulk", "--config", path.join(root, "wrangler.d1.json"), "--env", "production",
    ], {
      cwd: root, input: JSON.stringify(secrets), encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Secret upload failed. Check Cloudflare login and retry.");
    console.log("Verify names with npm run secrets:list:prod. Application deployment is a separate step.");
  } else {
    throw new Error("Usage: node scripts/setup-worker-secrets.mjs [--prepare [--reuse-google]]");
  }
} catch (error) {
  // Never print parsed environment values or the upload payload.
  console.error(error instanceof Error ? error.message : "Secret setup failed.");
  process.exitCode = 1;
}
