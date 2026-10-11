import { AccountCard } from "./account-card";

export function Welcome({ configured, returnTo = "/", invitation = false }: {
  configured: boolean; returnTo?: string; invitation?: boolean;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <section className="w-full max-w-xl rounded-3xl border border-foreground/10 p-8 shadow-sm sm:p-12">
        <p className="mb-6 text-sm font-semibold uppercase tracking-widest text-teal-600 dark:text-teal-400">Personal chat service</p>
        <h1 className="text-5xl font-semibold tracking-tight">pchat</h1>
        <p className="mt-6 text-lg leading-8 text-foreground/70">
          {invitation ? "You’re invited to a private conversation. Sign in to join." : "Conversations, photos, and videos. Share a link and bring a friend."}
        </p>
        <AccountCard configured={configured} returnTo={returnTo} />
      </section>
    </main>
  );
}
