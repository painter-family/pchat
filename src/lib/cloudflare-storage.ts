import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { PlatformProxy } from "wrangler";

export type CloudStorage = { DB: D1Database; MEDIA: R2Bucket };
const state = globalThis as typeof globalThis & { pchatCloudProxy?: Promise<PlatformProxy<CloudStorage>> };

export function storageBackend(): "cloudflare" | "local" {
  const value = process.env.PCHAT_STORAGE || "cloudflare";
  if (value !== "cloudflare" && value !== "local") throw new Error("PCHAT_STORAGE must be cloudflare or local.");
  return value;
}

export async function cloudStorage(): Promise<CloudStorage> {
  if (process.env.PCHAT_RUNTIME === "worker") {
    // Resolve per request; a deployed Worker must never start a Wrangler proxy.
    const env = getCloudflareContext().env as unknown as CloudStorage;
    if (!env.DB || !env.MEDIA) throw new Error("Worker DB and MEDIA bindings are missing.");
    return env;
  }
  if (!state.pchatCloudProxy) {
    state.pchatCloudProxy = (async () => {
      const configPath = path.join(process.cwd(), "wrangler.d1.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const development = config.env?.development;
      if (development?.d1_databases?.[0]?.database_name !== "pchat-dev" ||
          development?.r2_buckets?.[0]?.bucket_name !== "pchat-dev-media" ||
          development?.d1_databases?.[0]?.remote !== true || development?.r2_buckets?.[0]?.remote !== true) {
        throw new Error("Development storage must bind remote pchat-dev and pchat-dev-media in wrangler.d1.json.");
      }
      // Runtime require keeps the local-only SDK and native binaries out of Workers.
      const { getPlatformProxy } = createRequire(path.join(process.cwd(), "package.json"))("wrangler") as typeof import("wrangler");
      const proxy = await getPlatformProxy<CloudStorage>({ configPath, environment: "development", remoteBindings: true, envFiles: [] });
      if (!proxy.env.DB || !proxy.env.MEDIA) {
        await proxy.dispose();
        throw new Error("Cloudflare development DB and MEDIA bindings are missing.");
      }
      return proxy;
    })().catch((error) => {
      state.pchatCloudProxy = undefined;
      throw error;
    });
  }
  return (await state.pchatCloudProxy).env;
}
