import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { userSessions } from "@/lib/user-sessions";
import { notifyUsers } from "@/lib/chat-live";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: { error: "/auth/error" },
  callbacks: {
    signIn({ account, profile }) {
      return account?.provider === "google" && profile?.email_verified === true;
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === "google" && profile) {
        if (profile.sub !== account.providerAccountId) throw new Error("Google identity mismatch.");
        token.sub = await (await userSessions()).googleAccount(account.providerAccountId, {
          email: String(profile.email || ""), name: String(profile.name || profile.email || "Google user"),
          verified: profile.email_verified === true,
        });
        const aliases = await (await userSessions()).all<{ alias_id: string }>("SELECT alias_id FROM user_aliases WHERE user_id=?", [token.sub]);
        await notifyUsers([token.sub, ...aliases.map(alias => alias.alias_id)]);
      } else if (token.sub) {
        // Keep existing browser cookies useful after legacy accounts are merged.
        token.sub = await (await userSessions()).canonicalId(token.sub);
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
