/**
 * Domain errors.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Deliberately in a module of their own, importing NOTHING — not Prisma, not
 * Auth.js, not Next.js.
 *
 * They were originally defined alongside the permission kernel and the task
 * service, which meant anything wanting to MAP an error to a status code had
 * to import the database and the auth stack to do it. That made the HTTP error
 * mapping untestable in isolation, and it was untestable for a reason: the
 * dependency was wrong. Turning an exception into a status code is pure logic.
 *
 * `permissions.ts` and `service.ts` re-export these, so existing imports keep
 * working and no caller needs to know they moved.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * The record does not exist, OR the caller may not see it.
 *
 * These two cases MUST remain indistinguishable. A separate "forbidden" for
 * reads would confirm the record exists, which is exactly what someone walking
 * ids is trying to learn. The HTTP layer renders this as a 404 whose body does
 * not even name the entity type.
 */
export class NotFoundError extends Error {
  constructor(what = "Resource") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/**
 * The caller can see the record but may not perform this action.
 *
 * Safe to be specific here: they already know the record exists, so naming the
 * action they were refused leaks nothing new and saves a support call.
 */
export class ForbiddenError extends Error {
  constructor(action: string) {
    super(`Not permitted: ${action}`);
    this.name = "ForbiddenError";
  }
}

/** A write was attempted against a stale version of the row. */
export class ConflictError extends Error {
  constructor(
    message: string,
    /** Current state, so the caller can show a diff rather than just failing. */
    public readonly current?: unknown
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * The request was well-formed, but the operation is not valid in this state.
 *
 * Distinct from a validation error: "this task cannot go from Assigned to
 * Completed" is not a malformed request, and a client should react to it
 * differently — show the message to the user rather than log a bug.
 */
export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOperationError";
  }
}

export function assertPermitted(condition: boolean, action: string): asserts condition {
  if (!condition) throw new ForbiddenError(action);
}
