import { getActingUser } from "@/lib/auth/session";
import { mapError, unauthorised } from "./respond";
import type { ActingUser } from "@/lib/auth/permissions";

/**
 * Wraps a route handler with authentication and error mapping.
 *
 * Separate from respond.ts because this — and only this — needs the session,
 * which drags in Auth.js and Next. Keeping the pure error mapping free of that
 * dependency is what makes it testable in isolation.
 *
 * Every route uses this. One that forgets has no session and no error
 * translation, and fails obviously rather than subtly. That is the intent: the
 * failure mode of forgetting should be loud.
 *
 * ── getActingUser, NOT requireActingUser ──────────────────────────────────
 * The difference is the whole point. `requireActingUser()` REDIRECTS when
 * there is no usable session — right for a page, wrong here twice over.
 *
 * A redirect is thrown, so inside this try/catch it never reached the browser:
 * it fell through `mapError` to a 500 with "Something went wrong" and an
 * `[api] unhandled error` line in the log. A leaver's tab refreshing therefore
 * produced a server-error page and a logged fault for an entirely expected
 * condition — noise in exactly the place production monitoring needs signal.
 *
 * And a 307 to an HTML sign-in page is not a useful answer to a JSON client
 * anyway. `getActingUser()` returns null instead — for no session AND for a
 * session whose user is no longer active — which becomes a clean 401.
 *
 * Pages are untouched and still use `requireActingUser()`: redirecting a
 * browser to sign-in is right for a browser.
 */
export function route<TCtx = unknown>(
  handler: (user: ActingUser, request: Request, ctx: TCtx) => Promise<Response>
) {
  return async (request: Request, ctx: TCtx): Promise<Response> => {
    try {
      const user = await getActingUser();
      if (!user) return unauthorised();

      return await handler(user, request, ctx);
    } catch (e) {
      return mapError(e);
    }
  };
}
