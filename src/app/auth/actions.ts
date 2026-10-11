"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { isGoogleAuthConfigured } from "@/lib/auth-config";

export async function signInWithGoogle() {
  await signInWithGoogleAt("/");
}

export async function signInWithGoogleAt(returnTo: string) {
  if (!isGoogleAuthConfigured()) redirect("/auth/error");
  const destination = /^\/(?:chat\/[\w-]+|invite\/[\w-]+)?$/.test(returnTo) ? returnTo : "/";

  try {
    await signIn("google", { redirectTo: destination });
  } catch (error) {
    if (error instanceof AuthError) redirect("/auth/error");
    throw error;
  }
}

export async function signOutOfApp() {
  await signOut({ redirectTo: "/" });
}
