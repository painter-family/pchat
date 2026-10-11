import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">Unable to sign in</h1>
      <p className="mt-4 text-foreground/70">
        Google sign-in could not be completed. Try again, or contact the app owner
        if the problem continues.
      </p>
      <Link className="mt-6 underline underline-offset-4" href="/">Back to pchat</Link>
    </main>
  );
}
