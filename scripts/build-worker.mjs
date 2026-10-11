import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const result = spawnSync(process.execPath, [
  "node_modules/@opennextjs/cloudflare/dist/cli/index.js", "build",
  "--config", "wrangler.d1.json", "--env", "production", ...process.argv.slice(2),
], { stdio: "inherit", env: { ...process.env, PCHAT_BUILD_TARGET: "worker" } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

// OpenNext copies .env* into this module by default. Production credentials
// must come exclusively from Worker bindings, not from the deployment bundle.
writeFileSync(".open-next/cloudflare/next-env.mjs",
  "export const development = {};\nexport const production = {};\nexport const test = {};\n");
function removeEnvFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) removeEnvFiles(file);
    else if (entry.isFile() && /^\.env(?:\.|$)/.test(entry.name)) unlinkSync(file);
  }
}
removeEnvFiles(".open-next");
await import("./check-worker-artifact.mjs");
