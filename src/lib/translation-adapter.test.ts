// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./cloudflare-storage", () => ({ storageBackend: () => "cloudflare", cloudStorage: async () => ({ AI: { run } }) }));
import { translateText } from "./chat-languages";
afterEach(() => vi.resetAllMocks());

test("long translation inputs retain every chunk and line break in source order", async () => {
  run.mockImplementation(async (_model, input) => ({ translated_text: input.text }));
  const source = "Hola, nos vemos mañana. ".repeat(80) + "\n\n" + "¿Cómo estás?";
  expect(await translateText(source, "es", "en")).toBe(source);
  expect(run.mock.calls.length).toBeGreaterThan(1);
  for (const [model, input] of run.mock.calls) {
    expect(model).toBe("@cf/meta/m2m100-1.2b");
    expect(input.source_lang).toBe("spanish"); expect(input.target_lang).toBe("english");
    expect(input.text.length).toBeLessThanOrEqual(401);
  }
});
test("an empty model response is a failure instead of losing original text", async () => {
  run.mockResolvedValue({ translated_text: "" });
  await expect(translateText("Hola", "es", "en")).rejects.toThrow("Empty translation");
});
