import { redirect } from "next/navigation";
import { auth } from "./auth";
import { loadActingUser, type ActingUser } from "./permissions";

/**
 * The bridge from "there is a session" to "here is who is acting".
 *
 * Every page and route handler that touches data starts here. It deliberately
 * re-reads role, engagement membership and the report chain from the database
 * on every request rather than trusting the token, so that:
 *
 *   - deactivating someone takes effect on their next request, not when their
 *     12-hour session happens to expire
 *   - a role change, or being added to an engagement, applies immediately
 *   - a tampered or stale token cannot grant anything
 *
 * The cost is a couple of indexed queries per request. At this scale that is
 * not a trade worth making the other way.
 */

/** Throws (redirects) if not signed in. Use in pages that require a user. */
export async function requireActingUser(): Promise<ActingUser> {
  const session = await auth();

  if (!session?.user?.id) redirect("/signin");

  try {
    return await loadActingUser(BigInt(session.user.id));
  } catch {
    // The user was deactivated, deleted, or the token is stale. Send them
    // back to sign-in rather than showing a broken page.
    redirect("/signin?error=session_invalid");
  }
}

/** Null instead of redirecting. For pages that render differently when signed out. */
export async function getActingUser(): Promise<ActingUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  try {
    return await loadActingUser(BigInt(session.user.id));
  } catch {
    return null;
  }
}

/** Display details for the header. Separate from ActingUser, which is authorisation only. */
export async function getSessionUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
}
