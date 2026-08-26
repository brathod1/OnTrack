import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/auth.config";

/**
 * Session gate.
 *
 * Uses the edge-safe config only. This checks that a session cookie exists
 * and redirects to /signin when it doesn't — nothing more.
 *
 * ⚠ This is NOT the authorisation layer. It cannot be: it has no database
 * access, so it cannot know which tasks a user may see. Every page and route
 * handler must still go through the permission kernel. Middleware that
 * appears to be "the security layer" is how systems end up with an
 * unprotected API behind a protected UI.
 */
export default NextAuth(authConfig).auth;

export const config = {
  // Match everything except Next.js internals and static assets. The auth
  // endpoints are allowed through by PUBLIC_PREFIXES in auth.config.ts rather
  // than excluded here, so the allow-list lives in one place.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
