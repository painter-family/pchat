import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Welcome } from "@/components/welcome";

// Test the page shell separately from the request-time server component.
vi.mock("@/app/auth/actions", () => ({ signInWithGoogle: vi.fn(), signInWithGoogleAt: vi.fn(), signOutOfApp: vi.fn() }));

afterEach(cleanup);

test("the signed-out home page offers Google login", () => {
  render(<Welcome configured />);

  expect(screen.getByRole("main")).toBeDefined();
  expect(screen.getByRole("heading", { level: 1, name: "pchat" })).toBeDefined();
  expect((screen.getByRole("button", { name: "Sign in with Google" }) as HTMLButtonElement).disabled).toBe(false);
});
