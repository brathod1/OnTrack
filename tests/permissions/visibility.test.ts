/**
 * Who can see which tasks.
 *
 * Every assertion here goes through `visibleTaskFilter` — the same function
 * every list query in the application composes. If this suite passes and the
 * application still leaks, it means someone wrote a query that didn't use the
 * kernel, which is the one failure mode these tests cannot catch. That is why
 * the rule is "no authorisation logic anywhere else", not "be careful".
 */

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import {
  loadActingUser,
  visibleTaskFilter,
  assertCanReadTask,
  canViewAllTasks,
  NotFoundError,
  type ActingUser,
} from "@/lib/auth/permissions";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeAll(async () => {
  await resetDatabase();
  firm = await buildFirm();

  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** Runs the real query path and returns display keys, sorted for stability. */
async function visibleKeys(user: ActingUser): Promise<string[]> {
  const rows = await prisma.task.findMany({
    where: visibleTaskFilter(user),
    select: { displayKey: true },
    orderBy: { displayKey: "asc" },
  });
  return rows.map((r) => r.displayKey);
}

const T = {
  t1: "TSK-TEST-0001", // EngA1, Eshan
  t2: "TSK-TEST-0002", // EngA1, Meera
  t3: "TSK-TEST-0003", // EngA2, Ellie
  t4: "TSK-TEST-0004", // EngB1, Esha
  t5: "TSK-TEST-0005", // EngB1, Ellie
  t6: "TSK-TEST-0006", // EngA1, Eshan + Esha contributing
} as const;

describe("employee visibility", () => {
  it("Eshan sees his own tasks and everything on his engagement", async () => {
    // He is assignee of t1 and t6, and a member of EngA1 which also holds t2.
    expect(await visibleKeys(actor.eshan!)).toEqual([T.t1, T.t2, T.t6]);
  });

  it("Eshan cannot see other engagements", async () => {
    const keys = await visibleKeys(actor.eshan!);
    expect(keys).not.toContain(T.t3); // different engagement, same client
    expect(keys).not.toContain(T.t4); // different client entirely
    expect(keys).not.toContain(T.t5);
  });

  it("a contributor sees a task on an engagement they do not belong to", async () => {
    // Esha is a member of EngB1 only, but contributes to t6 on EngA1.
    // Without the contributor branch she would be blind to work she is doing.
    const keys = await visibleKeys(actor.esha!);
    expect(keys).toContain(T.t6);
    expect(keys).toContain(T.t4); // her own EngB1 task
    expect(keys).toContain(T.t5); // engagement colleague's task
    expect(keys).not.toContain(T.t1); // EngA1, not a member, not contributing
    expect(keys).not.toContain(T.t3);
  });

  it("a user with no relationships sees nothing at all", async () => {
    // Chandra is ACTIVE and valid — she simply has no team, no manager and no
    // engagement. "Logged in" must never imply "can see the firm's work".
    expect(await visibleKeys(actor.chandra!)).toEqual([]);
  });
});

describe("cross-team staffing — the case a hierarchy gets wrong", () => {
  it("Ellie sees the Tax engagement she works on, though she is Audit and reports to Nikhil", async () => {
    const keys = await visibleKeys(actor.ellie!);
    expect(keys).toContain(T.t5); // her EngB1 task
    expect(keys).toContain(T.t4); // engagement colleague's, via membership
    expect(keys).toContain(T.t3); // her own Audit engagement
  });

  it("Meera sees Ellie's work on Meera's engagement, though Ellie is not her report", async () => {
    const keys = await visibleKeys(actor.meera!);
    expect(keys).toContain(T.t5);
  });

  it("Nikhil sees his report's task on someone else's engagement", async () => {
    // Ellie reports to Nikhil, so t5 is visible to him through the line-
    // management branch even though he has nothing to do with EngB1.
    const keys = await visibleKeys(actor.nikhil!);
    expect(keys).toContain(T.t5);
    expect(keys).toContain(T.t3);
  });
});

describe("manager visibility", () => {
  it("Meera sees her engagements and her reports' work", async () => {
    // EngA1 (t1, t2, t6) + EngB1 (t4, t5). Not t3 — different engagement,
    // and Ellie is not her report.
    expect(await visibleKeys(actor.meera!)).toEqual([T.t1, T.t2, T.t4, T.t5, T.t6]);
  });

  it("Meera cannot see another manager's engagement", async () => {
    expect(await visibleKeys(actor.meera!)).not.toContain(T.t3);
  });

  it("Nikhil cannot see the Tax engagement he has no part in", async () => {
    const keys = await visibleKeys(actor.nikhil!);
    expect(keys).not.toContain(T.t1);
    expect(keys).not.toContain(T.t2);
    expect(keys).not.toContain(T.t6);
  });
});

describe("partner visibility", () => {
  it("Priya sees all work for her client, across both engagements", async () => {
    // She is on neither engagement's member list — access comes from being
    // the engagement partner and the client relationship partner.
    expect(await visibleKeys(actor.priya!)).toEqual([T.t1, T.t2, T.t3, T.t6]);
  });

  it("Priya cannot see another partner's client", async () => {
    const keys = await visibleKeys(actor.priya!);
    expect(keys).not.toContain(T.t4);
    expect(keys).not.toContain(T.t5);
  });

  it("Quentin sees only his own client", async () => {
    expect(await visibleKeys(actor.quentin!)).toEqual([T.t4, T.t5]);
  });
});

describe("admin visibility", () => {
  it("sees every task", async () => {
    expect(await visibleKeys(actor.admin!)).toEqual([T.t1, T.t2, T.t3, T.t4, T.t5, T.t6]);
  });

  it("is the only role permitted the All Tasks view besides partners", async () => {
    expect(canViewAllTasks(actor.admin!)).toBe(true);
    expect(canViewAllTasks(actor.priya!)).toBe(true);
    expect(canViewAllTasks(actor.meera!)).toBe(false);
    expect(canViewAllTasks(actor.eshan!)).toBe(false);
  });
});

describe("soft-deleted tasks", () => {
  it("disappear from everyone, including admin", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t2 },
      data: { deletedAt: new Date() },
    });

    expect(await visibleKeys(actor.admin!)).not.toContain(T.t2);
    expect(await visibleKeys(actor.meera!)).not.toContain(T.t2);

    await prisma.task.update({
      where: { id: firm.tasks.t2 },
      data: { deletedAt: null },
    });
  });
});

describe("direct lookup by id returns 404, never 403", () => {
  // The security property: a user probing task ids must not be able to tell
  // "this exists but you may not see it" from "this does not exist". A 403
  // confirms the record exists, which is exactly what they are fishing for.

  it("throws NotFoundError for a task the user may not see", async () => {
    await expect(assertCanReadTask(actor.eshan!, firm.tasks.t3)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("throws the SAME error for a task id that does not exist", async () => {
    await expect(assertCanReadTask(actor.eshan!, 999_999_999n)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("the two cases are indistinguishable to the caller", async () => {
    const forbidden = await assertCanReadTask(actor.eshan!, firm.tasks.t3).catch((e) => e);
    const absent = await assertCanReadTask(actor.eshan!, 999_999_999n).catch((e) => e);

    // Same class, same message. Nothing in the response distinguishes them.
    expect(forbidden.constructor).toBe(absent.constructor);
    expect(forbidden.message).toBe(absent.message);
  });

  it("succeeds silently for a task the user may see", async () => {
    await expect(assertCanReadTask(actor.eshan!, firm.tasks.t1)).resolves.toBeUndefined();
  });

  it("a user with no relationships cannot read any task by id", async () => {
    for (const id of Object.values(firm.tasks)) {
      await expect(assertCanReadTask(actor.chandra!, id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});

describe("deactivated users", () => {
  it("cannot be loaded as an acting user at all", async () => {
    // A live session cookie must stop working the moment someone is
    // deactivated — the leaver path. The check is at load time, so it applies
    // to every request rather than only to the login endpoint.
    await prisma.user.update({
      where: { id: firm.users.eshan },
      data: { status: "INACTIVE", deactivatedAt: new Date() },
    });

    await expect(loadActingUser(firm.users.eshan)).rejects.toThrow(/not active/i);

    await prisma.user.update({
      where: { id: firm.users.eshan },
      data: { status: "ACTIVE", deactivatedAt: null },
    });
  });
});
