import { requireActingUser } from "@/lib/auth/session";
import { mapError } from "./respond";
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
 */
export function route<TCtx = unknown>(
  handler: (user: ActingUser, request: Request, ctx: TCtx) => Promise<Response>
) {
  return async (request: Request, ctx: TCtx): Promise<Response> => {
    try {
      const user = await requireActingUser();
      return await handler(user, request, ctx);
    } catch (e) {
      return mapError(e);
    }
  };
}
