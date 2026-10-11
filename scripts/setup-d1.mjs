import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "wrangler.d1.json");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const environments = ["development", "production"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args, "--config", configPath], {
    cwd: root,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr || result.stdout || "");
    }
    throw new Error("Wrangler failed. Run npm run cf:login, then retry. If you have multiple accounts, set CLOUDFLARE_ACCOUNT_ID first.");
  }
  return capture ? JSON.parse(result.stdout) : null;
}

try {
  // Check authentication before changing the configuration or creating assets.
  let databases = run(["d1", "list", "--json"], true);
  for (const environment of environments) {
    const binding = config.env[environment].d1_databases[0];
    let database = databases.find((item) => item.name === binding.database_name);
    if (!database) {
      console.log(`Creating ${binding.database_name} (${environment}).`);
      run(["d1", "create", binding.database_name, "--env", environment, "--update-config=false"]);
      databases = run(["d1", "list", "--json"], true);
      database = databases.find((item) => item.name === binding.database_name);
    }
    const id = database?.uuid ?? database?.id;
    if (!uuid.test(id || "")) throw new Error(`Could not find a valid ID for ${binding.database_name}.`);
    if (uuid.test(binding.database_id) && binding.database_id !== id) {
      throw new Error(`${binding.database_name} has a different ID in this account. Check CLOUDFLARE_ACCOUNT_ID before changing the binding.`);
    }
    binding.database_id = id;
    // Save each discovered ID so a partial setup can be resumed safely.
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`${environment}: ${binding.database_name} (${id})`);
  }
  console.log("Database bindings saved. Apply the schema with npm run d1:migrate:dev and npm run d1:migrate:prod.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
