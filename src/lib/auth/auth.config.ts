import type { NextAuthConfig } from "next-auth";

/**
 * The EDGE-SAFE half of the auth configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Next.js middleware runs on the Edge runtime, which has no Node APIs and
 * therefore cannot load Prisma. Anything imported here ends up in the edge
 * bundle, so this file must not import the database, the permission kernel,
 * or anything that reaches them transitively.
 *
 * It answers exactly one question: "is there a valid session cookie?" That is
 * all middleware should decide. Real authorisation — which tasks, which
 * fields, which transitions — happens in server components and route handlers
 * where the database is available, and always through the permission kernel.
 *
 * Treating middleware as the security boundary is a common and serious
 * mistake: it can tell you someone is signed in, never what they may see.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Paths reachable without a session. Everything else requires one. */
const PUBLIC_PREFIXES = ["/signin", "/api/auth", "/pending", "/_next", "/favicon"];

export const authConfig = {
  pages: {
    signIn: "/signin",
    error: "/signin",
  },

  session: {
    strategy: "jwt",
    // 12 hours: long enough for a working day without re-authenticating,
    // short enough that a forgotten session on a shared machine expires.
    maxAge: 12 * 60 * 60,
    updateAge: 60 * 60,
  },

  // Providers are added in auth.ts. Middleware only needs to read the cookie,
  // and the dev provider's authorize() touches the database.
  providers: [],

  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;

      if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;

      // Returning false makes Auth.js redirect to pages.signIn.
      return Boolean(auth?.user);
    },
  },

  trustHost: true,
} satisfies NextAuthConfig;
