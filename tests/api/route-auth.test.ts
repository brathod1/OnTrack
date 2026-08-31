/**
 * What the API does when there is no usable session.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS: `route()` used to call `requireActingUser()`, which
 * REDIRECTS. A redirect is thrown, so inside `route()`'s try/catch it never
 * reached anyone — it fell through `mapError` to a 500 with "Something went
 * wrong", plus an `[api] unhandled error` line in the log.
 *
 * So a deactivated person's browser tab refreshing produced a server error and
 * a logged fault for a completely expected condition. Access was still
 * correctly denied — this was never a bypass — but the status was wrong and
 * the noise lands in exactly the place production monitoring needs signal.
 *
 * ── Why this file mocks, when nothing else in the suite does ──────────────
 * Every other test here runs against a real PostgreSQL database on purpose.
 * This one mocks ONE thing: `auth()`, the session-cookie read. There is no way
 * to hold a genuine Auth.js session in a unit test, and the alternative —
 * asserting only on `unauthorised()` in isolation — would not have caught the
 * original defect, because that helper was never the broken part. The bug was
 * in which helper `route()` reached for.
 *
 * Everything below the cookie stays real: `loadActingUser` runs against the
 * test database, so the deactivated-user case exercises the actual status
 * check rather than a stub of it.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";

/** The only thing stubbed: what the session cookie resolves to. */
const session: { value: unknown } = { value: null };
vi.mock("@/lib/auth/auth", () => ({
  auth: async () => session.value,
  // `signIn`/`signOut`/`handlers` are never reached from this path, but the
  // module is imported as a whole, so the shape has to exist.
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: {},
  isEntraConfigured: false,
}));

const { route } = await import("@/lib/api/route");
const { requireActingUser, getActingUser } = await import("@/lib/auth/session");
const { ok } = await import("@/lib/api/respond");

let firm: Firm;
/** Records whether the wrapped handler was allowed to run at all. */
let handlerRan = false;

const handler = route(async (user) => {
  handlerRan = true;
  return ok({ id: user.id.toString() });
});

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  session.value = null;
  handlerRan = false;
});

const call = () => handler(new Request("http://localhost/api/v1/tasks"), undefined);

describe("an API request with no session", () => {
  it("returns 401, not a redirect and not a 500", async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("never runs the handler", async () => {
    // The status alone would not prove this. A handler that runs without a
    // user is the failure that matters.
    await call();
    expect(handlerRan).toBe(false);
  });

  it("says nothing specific — the body is generic JSON", async () => {
    const res = await call();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "Sign in required.",
    });
  });
});

describe("an API request from a deactivated user — the reported defect", () => {
  beforeEach(async () => {
    // A real session cookie for a real user who has since been deactivated.
    // loadActingUser refuses non-ACTIVE users, which is what used to surface
    // as a 500.
    await prisma.user.update({
      where: { id: firm.users.eshan },
      data: { status: UserStatus.INACTIVE, deactivatedAt: new Date() },
    });
    session.value = { user: { id: firm.users.eshan.toString() } };
  });

  it("returns 401, NOT 500", async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("returns the SAME body as an unauthenticated caller", async () => {
    // Distinguishing them would confirm to whoever holds the cookie that the
    // account is real — the same reasoning that makes an unauthorised read a
    // 404 rather than a 403.
    const res = await call();
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "Sign in required.",
    });
  });

  it("never runs the handler", async () => {
    await call();
    expect(handlerRan).toBe(false);
  });

  it("lets no NEXT_REDIRECT escape the API layer", async () => {
    // The precise mechanism of the old bug: redirect() throws an error whose
    // `digest` begins NEXT_REDIRECT. If one ever reaches the caller again,
    // either as a throw or as a 500, this fails.
    let thrown: unknown = null;
    let res: Response | null = null;
    try {
      res = await call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    expect(res!.status).not.toBe(500);
    expect(String((thrown as { digest?: string })?.digest ?? "")).not.toContain("NEXT_REDIRECT");
  });
});

describe("an API request from an active user is unaffected", () => {
  it("runs the handler and returns its response", async () => {
    session.value = { user: { id: firm.users.eshan.toString() } };

    const res = await call();
    expect(res.status).toBe(200);
    expect(handlerRan).toBe(true);
    expect(await res.json()).toEqual({ id: firm.users.eshan.toString() });
  });
});

describe("page behaviour is unchanged", () => {
  it("requireActingUser still REDIRECTS when there is no session", async () => {
    // Pages must keep redirecting a browser to sign-in. This change was only
    // ever about the API; if it altered page behaviour it would be a
    // regression, so the distinction is pinned here rather than assumed.
    session.value = null;
    await expect(requireActingUser()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("requireActingUser still redirects a deactivated user", async () => {
    await prisma.user.update({
      where: { id: firm.users.eshan },
      data: { status: UserStatus.INACTIVE, deactivatedAt: new Date() },
    });
    session.value = { user: { id: firm.users.eshan.toString() } };

    await expect(requireActingUser()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("getActingUser returns null rather than redirecting — the API's primitive", async () => {
    session.value = null;
    await expect(getActingUser()).resolves.toBeNull();
  });
});
