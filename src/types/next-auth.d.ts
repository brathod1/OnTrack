import type { DefaultSession } from "next-auth";

/**
 * Adds the OnTrack user id to the session type.
 *
 * `id` is a string because JWT claims are JSON and BigInt does not survive
 * serialisation. Convert with BigInt(session.user.id) at the point of use —
 * `getActingUser()` in session.ts does this in one place so nothing else has
 * to remember.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}

export {};
