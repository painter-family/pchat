import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// Values are compared privately. Only filenames are reported on a failure.
const values = [];
for (const name of readdirSync(".")) {
  if (!/^\.env(?:\.|$)/.test(name) || !statSync(name).isFile()) continue;
  const env = parseEnv(readFileSync(name, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    if (/SECRET|TOKEN|PASSWORD|AUTH_GOOGLE_ID/.test(key) && value.length >= 16) values.push(Buffer.from(value));
  }
}
if (!existsSync(".open-next/worker.js")) throw new Error("Build the Worker first.");
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile()) {
      if (/^\.env(?:\.|$)/.test(entry.name)) throw new Error(`Environment file in Worker output: ${file}`);
      const bytes = readFileSync(file);
      if (values.some(value => bytes.includes(value))) throw new Error(`Credential in Worker output: ${file}`);
    }
  }
}
scan(".open-next");
console.log("Worker artifact contains no local environment files or configured credential values.");
