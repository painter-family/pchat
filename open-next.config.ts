import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Chat history is always read from D1, with no shared page/data cache.
export default defineCloudflareConfig();
