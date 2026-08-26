/**
 * What each role may CHANGE, as distinct from what they may see.
 *
 * Write access is deliberately narrower than read access. Being on an
 * engagement lets you see the work; it does not let you re-plan someone
 * else's. The three rules most likely to be questioned by users, and the
 * reasoning for each:
 *
 *   - A member cannot move their own due date. If they could, deadlines
 *     would mean nothing. They request a change instead, which notifies the
 *     manager and is logged.
 *   - A member cannot change their own priority, for the same reason.
 *   - A member can set an estimate only before work starts. Afterwards the
 *     original estimate is frozen, because Estimated-vs-Actual is worthless
 *     if the target moves once the work is underway.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import {
  loadActingUser,
  canManageTask,
  canWriteField,
  canLogTime,
  canEditOthersTime,
  overseeableUserIds,
  type ActingUser,
  type TaskWriteContext,
} from "@/lib/auth/permissions";
import { resolveTransition, availableTransitions } from "@/lib/tasks/transitions";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeAll(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** Build the write context the kernel expects, from a real row. */
async function ctx(taskId: bigint, viewerId: bigint): Promise<TaskWriteContext> {
  const t = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { engagement: true, contributors: true },
  });
  return {
    assigneeId: t.assigneeId,
    createdById: t.createdById,
    assignedById: t.assignedById,
    reviewerId: t.reviewerId,
    engagementId: t.engagementId,
    status: t.status,
    isContributor: t.contributors.some((c) => c.userId === viewerId),
    engagementPartnerId: t.engagement.partnerId,
    engagementManagerId: t.engagement.managerId,
  };
}

describe("who may direct the work", () => {
  it("the engagement manager may", async () => {
    expect(canManageTask(actor.meera!, await ctx(firm.tasks.t1, firm.users.meera))).toBe(true);
  });

  it("the engagement partner may", async () => {
    expect(canManageTask(actor.priya!, await ctx(firm.tasks.t1, firm.users.priya))).toBe(true);
  });

  it("an admin may", async () => {
    expect(canManageTask(actor.admin!, await ctx(firm.tasks.t1, firm.users.admin))).toBe(true);
  });

  it("the assignee may NOT — owning the work is not the same as directing it", async () => {
    expect(canManageTask(actor.eshan!, await ctx(firm.tasks.t1, firm.users.eshan))).toBe(false);
  });

  it("an unrelated manager may not", async () => {
    expect(canManageTask(actor.nikhil!, await ctx(firm.tasks.t1, firm.users.nikhil))).toBe(false);
  });

  it("a line manager may direct their report's work on someone else's engagement", async () => {
    // t5 is on EngB1 (Meera's), assigned to Ellie (Nikhil's report).
    expect(canManageTask(actor.nikhil!, await ctx(firm.tasks.t5, firm.users.nikhil))).toBe(true);
  });
});

describe("protected fields", () => {
  it("a member cannot move their own due date", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    expect(canWriteField(actor.eshan!, c, "dueDate")).toBe(false);
  });

  it("a member cannot change their own priority", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    expect(canWriteField(actor.eshan!, c, "priority")).toBe(false);
  });

  it("a member cannot reassign their own task", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    expect(canWriteField(actor.eshan!, c, "assigneeId")).toBe(false);
  });

  it("a manager can do all three", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.meera);
    expect(canWriteField(actor.meera!, c, "dueDate")).toBe(true);
    expect(canWriteField(actor.meera!, c, "priority")).toBe(true);
    expect(canWriteField(actor.meera!, c, "assigneeId")).toBe(true);
  });

  it("only an admin can move a statutory due date — it is a matter of law", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.meera);
    expect(canWriteField(actor.meera!, c, "statutoryDueDate")).toBe(false);
    expect(canWriteField(actor.priya!, c, "statutoryDueDate")).toBe(false);
    expect(canWriteField(actor.admin!, c, "statutoryDueDate")).toBe(true);
  });

  it("the assignee owns the state of their own work", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    expect(canWriteField(actor.eshan!, c, "status")).toBe(true);
    expect(canWriteField(actor.eshan!, c, "isBlocked")).toBe(true);
    expect(canWriteField(actor.eshan!, c, "title")).toBe(true);
  });

  it("an unrelated user can write nothing", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.chandra);
    for (const field of ["title", "status", "dueDate", "priority", "isBlocked"] as const) {
      expect(canWriteField(actor.chandra!, c, field)).toBe(false);
    }
  });
});

describe("estimates freeze once work begins", () => {
  it("a member may set an estimate while the task is still ASSIGNED", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    expect(c.status).toBe(TaskStatus.ASSIGNED);
    expect(canWriteField(actor.eshan!, c, "currentEstimateMinutes")).toBe(true);
  });

  it("a member may NOT once it is IN_PROGRESS", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.eshan)), status: TaskStatus.IN_PROGRESS };
    expect(canWriteField(actor.eshan!, c, "currentEstimateMinutes")).toBe(false);
  });

  it("a manager may at any point — planning is their job", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.meera)), status: TaskStatus.IN_PROGRESS };
    expect(canWriteField(actor.meera!, c, "currentEstimateMinutes")).toBe(true);
  });
});

describe("who may log time", () => {
  it("the assignee may", async () => {
    expect(canLogTime(actor.eshan!, await ctx(firm.tasks.t1, firm.users.eshan))).toBe(true);
  });

  it("a contributor may — this is the owner-plus-contributors model", async () => {
    expect(canLogTime(actor.esha!, await ctx(firm.tasks.t6, firm.users.esha))).toBe(true);
  });

  it("the reviewer may, so review time is not invisible", async () => {
    expect(canLogTime(actor.meera!, await ctx(firm.tasks.t4, firm.users.meera))).toBe(true);
  });

  it("an engagement colleague who is neither may NOT", async () => {
    // Esha is on EngB1 and can SEE t5, but logging hours against work she
    // does not own would make effort unattributable.
    expect(canLogTime(actor.esha!, await ctx(firm.tasks.t5, firm.users.esha))).toBe(false);
  });

  it("nobody may log time to a cancelled task", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.eshan)), status: TaskStatus.CANCELLED };
    expect(canLogTime(actor.eshan!, c)).toBe(false);
    expect(canLogTime(actor.meera!, c)).toBe(false);
  });
});

describe("editing someone else's time entry", () => {
  it("anyone may edit their own", () => {
    expect(canEditOthersTime(actor.eshan!, firm.users.eshan)).toBe(true);
  });

  it("a line manager may edit a report's", () => {
    expect(canEditOthersTime(actor.meera!, firm.users.eshan)).toBe(true);
  });

  it("a manager may NOT edit someone who is not their report", () => {
    expect(canEditOthersTime(actor.nikhil!, firm.users.eshan)).toBe(false);
  });

  it("a peer may not", () => {
    expect(canEditOthersTime(actor.esha!, firm.users.eshan)).toBe(false);
  });

  it("an admin may — and every such edit is attributed and logged", () => {
    expect(canEditOthersTime(actor.admin!, firm.users.eshan)).toBe(true);
  });
});

describe("oversight scope", () => {
  it("a member oversees only themselves", () => {
    expect(overseeableUserIds(actor.eshan!)).toEqual([firm.users.eshan]);
  });

  it("a manager oversees their reports", () => {
    const ids = overseeableUserIds(actor.meera!) as bigint[];
    expect(ids).toContain(firm.users.eshan);
    expect(ids).toContain(firm.users.esha);
    expect(ids).not.toContain(firm.users.ellie);
  });

  it("an admin oversees everyone", () => {
    expect(overseeableUserIds(actor.admin!)).toBe("ALL");
  });
});

describe("status transitions", () => {
  const facts = {
    openSubtaskCount: 0,
    hasTimeLogged: true,
    reviewRequired: false,
    reviewerId: null as bigint | null,
  };

  it("the assignee may start work", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    const r = resolveTransition(actor.eshan!, c, facts, { to: TaskStatus.IN_PROGRESS });
    expect(r.ok).toBe(true);
  });

  it("an unrelated user may not", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.chandra);
    const r = resolveTransition(actor.chandra!, c, facts, { to: TaskStatus.IN_PROGRESS });
    expect(r.ok).toBe(false);
  });

  it("a task cannot skip from ASSIGNED straight to COMPLETED", async () => {
    const c = await ctx(firm.tasks.t1, firm.users.eshan);
    const r = resolveTransition(actor.eshan!, c, facts, { to: TaskStatus.COMPLETED });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot move/i);
  });

  it("a member may not reopen a completed task", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.eshan)), status: TaskStatus.COMPLETED };
    const r = resolveTransition(actor.eshan!, c, facts, {
      to: TaskStatus.IN_PROGRESS,
      reason: "found an error",
    });
    expect(r.ok).toBe(false);
  });

  it("a manager may reopen — but only with a reason", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.meera)), status: TaskStatus.COMPLETED };

    const without = resolveTransition(actor.meera!, c, facts, { to: TaskStatus.IN_PROGRESS });
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.error).toMatch(/reason is required/i);

    const withReason = resolveTransition(actor.meera!, c, facts, {
      to: TaskStatus.IN_PROGRESS,
      reason: "Client provided revised figures",
    });
    expect(withReason.ok).toBe(true);
  });

  it("submitting for review needs a reviewer", async () => {
    const c = { ...(await ctx(firm.tasks.t4, firm.users.esha)), status: TaskStatus.IN_PROGRESS };
    const noReviewer = resolveTransition(
      actor.esha!,
      c,
      { ...facts, reviewRequired: true, reviewerId: null },
      { to: TaskStatus.REVIEW }
    );
    expect(noReviewer.ok).toBe(false);
    if (!noReviewer.ok) expect(noReviewer.error).toMatch(/reviewer/i);
  });

  it("a task requiring review cannot be completed directly", async () => {
    const c = { ...(await ctx(firm.tasks.t4, firm.users.esha)), status: TaskStatus.IN_PROGRESS };
    const r = resolveTransition(
      actor.esha!,
      c,
      { ...facts, reviewRequired: true, reviewerId: firm.users.meera },
      { to: TaskStatus.COMPLETED }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires review/i);
  });

  it("open subtasks block completion, and the message says how many", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.eshan)), status: TaskStatus.IN_PROGRESS };
    const r = resolveTransition(
      actor.eshan!,
      c,
      { ...facts, openSubtaskCount: 3 },
      { to: TaskStatus.COMPLETED }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/3 subtask/i);
  });

  it("a manager may override open subtasks, with a reason", async () => {
    const c = { ...(await ctx(firm.tasks.t1, firm.users.meera)), status: TaskStatus.IN_PROGRESS };
    const r = resolveTransition(
      actor.meera!,
      c,
      { ...facts, openSubtaskCount: 3, overrideGuards: true },
      { to: TaskStatus.COMPLETED, reason: "Remaining items moved to next year's engagement" }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/3 open subtask/i);
  });

  it("completing with no time logged warns but does not block", async () => {
    // Blocking would just teach people to log a fake 15 minutes.
    const c = { ...(await ctx(firm.tasks.t1, firm.users.eshan)), status: TaskStatus.IN_PROGRESS };
    const r = resolveTransition(
      actor.eshan!,
      c,
      { ...facts, hasTimeLogged: false },
      { to: TaskStatus.COMPLETED }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/no time/i);
  });

  it("only offers transitions the user can actually perform", async () => {
    const memberCtx = await ctx(firm.tasks.t1, firm.users.eshan);
    const memberOptions = availableTransitions(actor.eshan!, memberCtx, facts).map((t) => t.to);
    expect(memberOptions).toContain(TaskStatus.IN_PROGRESS);
    expect(memberOptions).not.toContain(TaskStatus.CANCELLED); // manager only

    const managerCtx = await ctx(firm.tasks.t1, firm.users.meera);
    const managerOptions = availableTransitions(actor.meera!, managerCtx, facts).map((t) => t.to);
    expect(managerOptions).toContain(TaskStatus.CANCELLED);
  });
});
