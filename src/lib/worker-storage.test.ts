// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

const context = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => context }));
import { cloudStorage } from "./cloudflare-storage";
import { chatStore } from "./chat-store";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & { pchatD1Store?: unknown }).pchatD1Store;
});

test("Worker requests use bound D1 and R2 without a development proxy", async () => {
  vi.stubEnv("PCHAT_RUNTIME", "worker");
  vi.stubEnv("PCHAT_STORAGE", "cloudflare");
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  context.env = { DB: { prepare }, MEDIA: {} };
  expect(await cloudStorage()).toBe(context.env);
  expect(await (await chatStore()).listChats("worker-user")).toEqual([]);
  expect(bind).toHaveBeenCalledWith("worker-user", "worker-user");
});

test("Worker cannot silently fall back to local SQLite or missing bindings", async () => {
  vi.stubEnv("PCHAT_RUNTIME", "worker");
  vi.stubEnv("PCHAT_STORAGE", "local");
  await expect(chatStore()).rejects.toThrow("Workers require D1/R2");
  vi.stubEnv("PCHAT_STORAGE", "cloudflare");
  context.env = {};
  await expect(chatStore()).rejects.toThrow("bindings are missing");
});
