import type { Session } from "next-auth";
import { signInWithGoogle, signInWithGoogleAt, signOutOfApp } from "@/app/auth/actions";

const buttonClass =
  "mt-5 rounded-xl border border-foreground/20 px-5 py-3 font-medium hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

export function AccountCard({
  user,
  configured,
  returnTo = "/",
}: {
  user?: Session["user"];
  configured: boolean;
  returnTo?: string;
}) {
  if (user) {
    return (
      <div className="mt-8 border-t border-foreground/10 pt-6">
        <p className="font-medium">Signed in as {user.name || user.email || "Google user"}</p>
        {user.email && <p className="mt-1 text-sm text-foreground/60">{user.email}</p>}
        <form action={signOutOfApp}>
          <button className={buttonClass} type="submit">Sign out</button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-foreground/10 pt-6">
      <p className="text-foreground/70">Sign in to pchat with your Google account.</p>
      <form action={returnTo === "/" ? signInWithGoogle : signInWithGoogleAt.bind(null, returnTo)}>
        <button className={buttonClass} type="submit" disabled={!configured}>
          Sign in with Google
        </button>
      </form>
      {!configured && (
        <p className="mt-3 text-sm text-foreground/60" role="status">
          Google sign-in is not available yet.
        </p>
      )}
    </div>
  );
}
