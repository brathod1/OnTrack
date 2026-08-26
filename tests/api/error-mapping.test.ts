/**
 * How errors become HTTP responses.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * This is a SECURITY test, not a formatting one. The status code and body an
 * API returns on failure is an information channel, and the most common way
 * to leak through it is to be helpful:
 *
 *   - 403 on a record the caller may not see CONFIRMS THE RECORD EXISTS.
 *     Someone walking task ids learns the firm's task count and which ids are
 *     real, without ever reading a task.
 *   - A stack trace or driver message in a 500 hands over table names, column
 *     names and library versions.
 *
 * These need no database, so they run in milliseconds and there is no excuse
 * for not asserting them.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { mapError, toJsonSafe } from "@/lib/api/respond";
// Imported from @/lib/errors, not from the permission kernel or the task
// service. If this test had to import either, the error mapping would be
// coupled to Prisma and Auth.js — which is exactly the dependency that made
// this file fail to load in the first place.
import {
  ConflictError,
  ForbiddenError,
  InvalidOperationError,
  NotFoundError,
} from "@/lib/errors";

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("unauthorised reads are indistinguishable from missing records", () => {
  it("NotFoundError maps to 404", async () => {
    const res = mapError(new NotFoundError("Task"));
    expect(res.status).toBe(404);
  });

  it("says nothing about what was or was not found", async () => {
    // NotFoundError("Task") carries "Task not found" internally. The response
    // must not echo it — "Task not found" tells a prober the id space is
    // tasks and that their guess was well-formed.
    const res = mapError(new NotFoundError("Task"));
    const b = await body(res);
    expect(b.message).toBe("Not found.");
    expect(JSON.stringify(b)).not.toMatch(/task/i);
  });

  it("a forbidden READ and an absent record produce identical responses", async () => {
    // The service loads through visibleTaskFilter, so both arrive as
    // NotFoundError. This asserts the mapping keeps them identical rather
    // than helpfully distinguishing them later.
    const forbiddenRead = mapError(new NotFoundError("Task"));
    const absent = mapError(new NotFoundError("Task"));

    expect(forbiddenRead.status).toBe(absent.status);
    expect(await body(forbiddenRead)).toEqual(await body(absent));
  });
});

describe("403 is reserved for actions on records you can already see", () => {
  it("ForbiddenError maps to 403", () => {
    expect(mapError(new ForbiddenError("change dueDate")).status).toBe(403);
  });

  it("names the action, which leaks nothing the caller did not already know", async () => {
    const b = await body(mapError(new ForbiddenError("change dueDate")));
    expect(b.message).toMatch(/dueDate/);
  });
});

describe("conflicts", () => {
  it("ConflictError maps to 409", () => {
    expect(mapError(new ConflictError("changed by someone else")).status).toBe(409);
  });

  it("returns the current state so the UI can show what changed", async () => {
    const err = new ConflictError("changed by someone else", {
      currentVersion: "2026-08-26T10:00:00.000Z",
      task: { title: "Renamed by the first editor" },
    });
    const b = await body(mapError(err));
    expect(b.current).toMatchObject({ task: { title: "Renamed by the first editor" } });
  });
});

describe("invalid operations are 422, not 400", () => {
  it("distinguishes a malformed request from an impossible one", async () => {
    // 400 means "fix your JSON". 422 means "this task cannot go there from
    // here". A client needs to react differently: one is a bug, the other is
    // a message to show the user.
    const malformed = mapError(new ZodError([]));
    const impossible = mapError(new InvalidOperationError("Cannot move from Assigned to Completed."));

    expect(malformed.status).toBe(400);
    expect(impossible.status).toBe(422);
  });

  it("passes the explanation through, since it is written for a person", async () => {
    const b = await body(mapError(new InvalidOperationError("Moving a deadline requires a reason.")));
    expect(b.message).toMatch(/requires a reason/);
  });
});

describe("validation errors name the fields", () => {
  it("groups messages by field path", async () => {
    const schema = z.object({
      title: z.string().min(3),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const err = schema.safeParse({ title: "x", dueDate: "tomorrow" });
    expect(err.success).toBe(false);

    const b = await body(mapError(err.success ? new Error("unreachable") : err.error));
    expect(b.error).toBe("invalid_request");
    expect(b.fields).toHaveProperty("title");
    expect(b.fields).toHaveProperty("dueDate");
  });
});

describe("unexpected errors reveal nothing", () => {
  it("maps to 500 with a generic message", async () => {
    const res = mapError(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: "server_error", message: "Something went wrong." });
  });

  it("never includes the original message or a stack", async () => {
    const e = new Error("relation \"users\" does not exist");
    e.stack = "at prisma.user.findMany (/app/node_modules/...)";

    const serialised = JSON.stringify(await body(mapError(e)));
    expect(serialised).not.toMatch(/users/);
    expect(serialised).not.toMatch(/node_modules/);
    expect(serialised).not.toMatch(/prisma/i);
  });
});

describe("BigInt serialisation", () => {
  it("converts ids to strings so responses do not throw", () => {
    // JSON.stringify throws on BigInt. Every id in this schema is one, so
    // without this every successful response would be a 500.
    const out = toJsonSafe({ id: 42n, nested: { assigneeId: 7n } }) as Record<string, unknown>;
    expect(out.id).toBe("42");
    expect((out.nested as Record<string, unknown>).assigneeId).toBe("7");
  });

  it("handles arrays and nulls", () => {
    const out = toJsonSafe({ ids: [1n, 2n], missing: null }) as Record<string, unknown>;
    expect(out.ids).toEqual(["1", "2"]);
    expect(out.missing).toBeNull();
  });
});
