import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { UserStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentOrganizationId, getDefaultRoleIdForNewUser } from "@/lib/org/current";
import { authConfig } from "./auth.config";

/**
 * The full auth configuration — database access included.
 *
 * Used by the route handler and by server components. NOT by middleware,
 * which uses auth.config.ts (see the note there about the Edge runtime).
 */

// ── Entra ID: present only when configured ──────────────────────────────────
// The app registration is pending approval. Rather than half-wire it or leave
// a commented-out block to rot, the provider is added only when its three
// environment variables exist. Adding them to .env switches it on with no
// code change.

const entraTenant = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
const entraClientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const entraSecret = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;

export const isEntraConfigured = Boolean(entraTenant && entraClientId && entraSecret);

/**
 * Development sign-in.
 *
 * ⚠ Guarded three ways, because this provider bypasses authentication
 * entirely and must never reach a deployed environment:
 *   1. Only added to the providers array when NODE_ENV === "development"
 *   2. authorize() re-checks NODE_ENV at call time
 *   3. Only signs in users that already exist and are ACTIVE — it creates
 *      nobody, so it cannot manufacture an admin
 *
 * The point is that no developer should need Entra tenant access, an internet
 * connection, or an approved app registration simply to run the app locally.
 */
const devProvider = Credentials({
  id: "dev",
  name: "Development sign-in",
  credentials: { email: { label: "Email", type: "email" } },

  async authorize(credentials) {
    if (process.env.NODE_ENV !== "development") return null;

    const email = String(credentials?.email ?? "").trim().toLowerCase();
    if (!email) return null;

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, status: true },
    });

    // Same refusal for "no such user" and "not active" — no enumeration.
    if (!user || user.status !== UserStatus.ACTIVE) return null;

    return { id: user.id.toString(), email: user.email, name: user.name };
  },
});

const providers: NextAuthConfig["providers"] = [];

if (isEntraConfigured) {
  providers.push(
    MicrosoftEntraID({
      clientId: entraClientId!,
      clientSecret: entraSecret!,
      // Pinning the issuer to OUR tenant is what stops any Microsoft account
      // in the world from reaching the callback. Without it the registration
      // would effectively be multi-tenant.
      issuer: `https://login.microsoftonline.com/${entraTenant}/v2.0`,
      authorization: { params: { scope: "openid profile email" } },
    })
  );
}

if (process.env.NODE_ENV === "development") {
  providers.push(devProvider);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,

  callbacks: {
    ...authConfig.callbacks,

    /**
     * Runs on every sign-in attempt, before a session exists.
     *
     * For Entra, this is where a first-time user is created as PENDING and
     * then refused. Letting first sign-in create an ACTIVE user would mean
     * every guest account in the tenant becomes an OnTrack user the moment
     * they open the URL.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider === "dev") return true;

      if (account?.provider === "microsoft-entra-id") {
        // `oid` is Entra's immutable object id. Matching on email would mean
        // someone loses their entire history when they change their name, or
        // inherits a predecessor's when an address is recycled.
        const oid = (profile as { oid?: string } | undefined)?.oid;
        const email = user.email?.toLowerCase();
        if (!oid || !email) return "/signin?error=missing_claims";

        const existing = await prisma.user.findFirst({
          where: { OR: [{ entraObjectId: oid }, { email }] },
        });

        if (!existing) {
          // The new user joins the organisation this installation serves.
          // Resolved rather than assumed — when a second organisation exists,
          // this becomes a lookup by domain or invitation and nothing else
          // in this callback changes.
          const organizationId = await getCurrentOrganizationId();
          // Least-privileged role available. They are PENDING and cannot sign
          // in until approved, but if that gate were ever weakened the failure
          // should be "can do nothing", not "can do everything".
          const roleId = await getDefaultRoleIdForNewUser(organizationId);

          await prisma.user.create({
            data: {
              entraObjectId: oid,
              email,
              name: user.name ?? email,
              status: UserStatus.PENDING,
              organizationId,
              roleId,
            },
          });
          return "/signin?error=pending_approval";
        }

        if (existing.status === UserStatus.PENDING) return "/signin?error=pending_approval";
        if (existing.status === UserStatus.INACTIVE) return "/signin?error=account_disabled";

        // Backfill the object id for a user seeded or created by an admin
        // before their first sign-in.
        if (!existing.entraObjectId) {
          await prisma.user.update({
            where: { id: existing.id },
            data: { entraObjectId: oid },
          });
        }

        user.id = existing.id.toString();
        return true;
      }

      return false;
    },

    /** Carry the OnTrack user id in the token. Nothing else — see below. */
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },

    /**
     * The session carries an id and nothing more.
     *
     * Deliberately NOT role, team or engagements. A token is issued once and
     * lives for hours; role and membership change in between. Putting them in
     * the token means a demoted manager keeps manager access until their
     * session expires. loadActingUser() re-reads them from the database on
     * every request instead — which is also what makes deactivation take
     * effect immediately, as Stage 3 tested.
     */
    async session({ session, token }) {
      if (token.uid && session.user) session.user.id = String(token.uid);
      return session;
    },
  },

  events: {
    async signIn({ user }) {
      if (!user.id) return;
      await prisma.user
        .update({ where: { id: BigInt(user.id) }, data: { lastSeenAt: new Date() } })
        .catch(() => {
          // Never fail a sign-in over a timestamp.
        });
    },
  },
});
