import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import {
  ConflictError,
  ForbiddenError,
  InvalidOperationError,
  NotFoundError,
} from "@/lib/errors";

/**
 * Turning results and errors into HTTP.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Pure. No Next.js, no Auth.js, no session. Uses the standard `Response`
 * rather than `NextResponse` — Next route handlers accept either, and we used
 * nothing Next-specific. That keeps this module testable on its own, which
 * matters because what it decides IS a security boundary.
 *
 * THE STATUS CODE THAT MATTERS: NotFoundError → 404, never 403.
 *
 * The service loads through `visibleTaskFilter`, so a record the caller may
 * not see simply isn't found. A 403 would confirm it exists — precisely what
 * someone walking ids wants to learn. 403 is reserved for "you can see this,
 * but you may not do that", which reveals nothing new.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** BigInt does not survive JSON.stringify — and every id here is one. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(toJsonSafe(body)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function ok(data: unknown): Response {
  return json(data, 200);
}

export function created(data: unknown): Response {
  return json(data, 201);
}

interface ErrorBody {
  error: string;
  message: string;
  fields?: Record<string, string[]>;
  current?: unknown;
}

/**
 * No usable session: not signed in, or signed in as somebody who is no longer
 * active.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 401, and deliberately the SAME 401 for both. "Your account was deactivated"
 * would confirm to whoever holds the cookie that the account is real, which is
 * the same reasoning that makes an unauthorised read a 404 rather than a 403.
 *
 * This exists because the API used to reach `requireActingUser()`, which
 * REDIRECTS. Inside a route handler that redirect is thrown, caught by
 * `route()`, and falls through `mapError` to a 500 — so a leaver's browser tab
 * refreshing produced "Something went wrong" and an `[api] unhandled error`
 * line in the log. Wrong status, and a routine condition logged as a fault.
 *
 * A redirect to an HTML sign-in page was never the right answer for a JSON
 * client in any case.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function unauthorised(): Response {
  return json(
    { error: "unauthorized", message: "Sign in required." } satisfies ErrorBody,
    401
  );
}

export function mapError(e: unknown): Response {
  if (e instanceof NotFoundError) {
    // Deliberately generic. NotFoundError("Task") carries "Task not found"
    // internally; echoing it would tell a prober their guess was well-formed.
    return json({ error: "not_found", message: "Not found." } satisfies ErrorBody, 404);
  }

  if (e instanceof ForbiddenError) {
    return json({ error: "forbidden", message: e.message } satisfies ErrorBody, 403);
  }

  if (e instanceof ConflictError) {
    return json(
      {
        error: "conflict",
        message: e.message,
        // Current state, so the UI can show what changed underneath the user
        // rather than just refusing.
        current: e.current,
      } satisfies ErrorBody,
      409
    );
  }

  if (e instanceof InvalidOperationError) {
    // 422, not 400. The request was well-formed; the operation is impossible
    // in this state. A client shows this to the user; a 400 it logs as a bug.
    return json({ error: "invalid_operation", message: e.message } satisfies ErrorBody, 422);
  }

  if (e instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of e.issues) {
      const key = issue.path.join(".") || "_";
      (fields[key] ??= []).push(issue.message);
    }
    return json(
      { error: "invalid_request", message: "Some fields are invalid.", fields } satisfies ErrorBody,
      400
    );
  }

  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") {
      return json({ error: "conflict", message: "That already exists." } satisfies ErrorBody, 409);
    }
    if (e.code === "P2003") {
      return json(
        { error: "invalid_reference", message: "A referenced record does not exist." } satisfies ErrorBody,
        422
      );
    }
    // A CHECK constraint or trigger fired — the last line of defence doing its
    // job. The caller's request was invalid, not the server broken, so 422.
    if (e.code === "P2010" || e.code === "P2034") {
      return json(
        { error: "rejected_by_database", message: "That change was rejected." } satisfies ErrorBody,
        422
      );
    }
  }

  // Anything else is a bug. Log server-side; tell the caller nothing. A driver
  // message like `relation "users" does not exist` is a free schema map, and a
  // stack trace names every library and path on the box.
  console.error("[api] unhandled error:", e);
  return json({ error: "server_error", message: "Something went wrong." } satisfies ErrorBody, 500);
}

/** Malformed JSON should be a 400, not a 500. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ZodError([
      { code: "custom", path: ["_"], message: "Request body must be valid JSON." },
    ]);
  }
}
