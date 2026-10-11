import path from "node:path";
import { readFile } from "node:fs/promises";
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
      const { getPlatformProxy } = await import("wrangler");
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
