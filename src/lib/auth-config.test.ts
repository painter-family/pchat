import { afterEach, expect, test, vi } from "vitest";
import { isGoogleAuthConfigured } from "./auth-config";

afterEach(() => vi.unstubAllEnvs());

test("all three server credentials are required", () => {
  vi.stubEnv("AUTH_SECRET", "test-session-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-client-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-client-secret");
  expect(isGoogleAuthConfigured()).toBe(true);

  for (const name of ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"]) {
    const original = process.env[name];
    vi.stubEnv(name, " ");
    expect(isGoogleAuthConfigured()).toBe(false);
    vi.stubEnv(name, original);
  }
});
