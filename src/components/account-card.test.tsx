import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AccountCard } from "./account-card";
import { signInWithGoogle, signOutOfApp } from "@/app/auth/actions";

vi.mock("@/app/auth/actions", () => ({
  signInWithGoogle: vi.fn(),
  signOutOfApp: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("sign-in is disabled while Google credentials are missing", () => {
  render(<AccountCard configured={false} />);
  const button = screen.getByRole("button", { name: "Sign in with Google" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("not available yet");
});

test("a signed-out user can start Google sign-in", () => {
  render(<AccountCard configured />);
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
  expect(signInWithGoogle).toHaveBeenCalledOnce();
});

test("a signed-in user sees their identity and can sign out", () => {
  render(<AccountCard configured user={{ name: "Pat", email: "pat@example.com" }} />);
  expect(screen.getByText("Signed in as Pat")).toBeDefined();
  expect(screen.getByText("pat@example.com")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(signOutOfApp).toHaveBeenCalledOnce();
});
