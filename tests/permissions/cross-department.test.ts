/**
 * Cross-department collaboration, and the line it must not cross.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE WORKFLOW: an employee needs a piece of work done by somebody in another
 * department — a tax executive wanting a data analyst's spreadsheet, an
 * auditor wanting a compliance check. They create a task and put it on that
 * person's plate. No department boundary applies, because departments are a
 * display attribute and have never been a permission boundary here.
 *
 * THE DEFECT THIS SUITE PINS: assignment attaches the assignee to the
 * engagement, and engagement membership used to grant visibility of EVERY task
 * on that engagement. Chained together, borrowing a specialist for one job
 * handed them read access to the whole engagement — a client's entire tax file
 * opened by asking for four hours of Excel.
 *
 * Nobody decided that. It fell out of two reasonable rules meeting:
 * "putting work on someone's plate is staffing them", which is right for
 * staffing, and "members see the engagement", which is right for members.
 * Being borrowed for one job is neither.
 *
 * So the attachment is now written as OBSERVER, which the kernel reads: it
 * records that the person is there without opening the rest of the file. The
 * assignee reaches their own task through the assignee relationship — the
 * relationship that actually describes why they are there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIXTURE CAST USED HERE
 *
 *   Eshan   — Staff, Direct Tax, member of EngA1. The requester.
 *   Ellie   — Staff, Statutory Audit, on EngA2 and EngB1. NOT on EngA1.
 *             The borrowed specialist from another department.
 *   Meera   — Manager and MANAGER-capacity member of EngA1.
 *   EngA1   — already holds t1, t2 and t6, none of which are Ellie's business.
 *
 * Eshan holds no task.assign and never gains any here. That is the other half
 * of the requirement: collaboration must not become authority.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { EngagementCapacity, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import {
  ForbiddenError,
  loadActingUser,
  type ActingUser,
} from "@/lib/auth/permissions";
import {
  assignTask,
  createTask,
  InvalidOperationError,
  listTasks,
  transitionTask,
  updateTask,
} from "@/lib/tasks/service";
import { createTaskSchema, listTasksSchema } from "@/lib/tasks/schemas";
import { getMyWork } from "@/lib/tasks/my-work";
import { addComment } from "@/lib/tasks/comments";
import { logManualTime } from "@/lib/time/service";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/**
 * Eshan asks Ellie for a piece of work on his engagement.
 *
 * Created through the real service, by a Staff user, exactly as the quick-create
 * screen would. Nothing here is set up behind the service's back.
 */
async function requestWorkFromEllie() {
  return createTask(
    actor.eshan!,
    createTaskSchema.parse({
      title: "Build the vendor-ageing pivot",
      engagementId: firm.engagements.a1.toString(),
      assigneeId: firm.users.ellie.toString(),
      dueDate: "2026-12-31",
    })
  );
}

/**
 * Reload from the database rather than reusing the actor built in beforeEach.
 *
 * The point of the whole permission model is that scope is re-read per request;
 * a cached ActingUser would be testing a snapshot taken before the membership
 * existed, and would pass whatever the kernel did.
 */
const reload = (id: bigint) => loadActingUser(id);

const visibleKeys = async (user: ActingUser) =>
  (await listTasks(user, listTasksSchema.parse({}))).tasks.map((t) => t.displayKey);

async function versionOf(taskId: bigint): Promise<string> {
  const t = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { updatedAt: true },
  });
  return t.updatedAt.toISOString();
}

function capacityOn(engagementId: bigint, userId: bigint) {
  return prisma.engagementMember.findFirst({
    where: {
      engagementId,
      userId,
      OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
    },
    select: { capacity: true },
  });
}

// ──────────────────────────────────────────── A, B and F: the core case

describe("an employee can hand work to another department", () => {
  it("a Staff member may assign across a team boundary, holding no task.assign", async () => {
    // Departments are not a permission boundary and never were. What makes
    // this legal is Eshan's membership of the engagement plus task.create —
    // not any authority over Ellie, whom he does not manage and never will.
    expect(actor.eshan!.capabilities.has("task.assign")).toBe(false);

    const task = await requestWorkFromEllie();
    expect(task.assigneeId).toBe(firm.users.ellie);
  });

  it("the assignee can see the task she was given", async () => {
    const task = await requestWorkFromEllie();

    const ellie = await reload(firm.users.ellie);
    expect(await visibleKeys(ellie)).toContain(task.displayKey);
  });

  it("but NOT the rest of the engagement — the leak this suite exists for", async () => {
    // Before OBSERVER, assignment wrote a MEMBER row and relationship 5 of
    // visibleTaskFilter opened every task on the engagement. Ellie would have
    // picked up t1, t2 and t6 — three tasks she has no connection to — as a
    // side-effect of being asked for one spreadsheet.
    await requestWorkFromEllie();

    const keys = await visibleKeys(await reload(firm.users.ellie));
    expect(keys).not.toContain("TSK-TEST-0001");
    expect(keys).not.toContain("TSK-TEST-0002");
    expect(keys).not.toContain("TSK-TEST-0006");
  });

  it("records the attachment as OBSERVER, not MEMBER", async () => {
    await requestWorkFromEllie();

    const membership = await capacityOn(firm.engagements.a1, firm.users.ellie);
    expect(membership?.capacity).toBe(EngagementCapacity.OBSERVER);
  });

  it("still WRITES the membership — the record must stay complete", async () => {
    // Not merely an implementation detail. ensureEngagementMembership is the
    // only writer of engagement membership in the application, so dropping the
    // row rather than narrowing it would make the membership list wrong and
    // silently break the mention picker, which reads it.
    const before = await capacityOn(firm.engagements.a1, firm.users.ellie);
    expect(before).toBeNull();

    await requestWorkFromEllie();

    expect(await capacityOn(firm.engagements.a1, firm.users.ellie)).not.toBeNull();
  });

  it("leaves the assignee's own engagements exactly as they were", async () => {
    // The change narrows what an OBSERVER row means. It must not touch what
    // Ellie can already see through memberships she holds properly.
    const before = await visibleKeys(actor.ellie!);
    await requestWorkFromEllie();
    const after = await visibleKeys(await reload(firm.users.ellie));

    for (const key of before) expect(after).toContain(key);
    expect(after).toContain("TSK-TEST-0003"); // her EngA2 task
    expect(after).toContain("TSK-TEST-0005"); // her EngB1 task
  });

  it("tells nobody else anything — an unrelated employee still sees nothing", async () => {
    await requestWorkFromEllie();

    // Chandra is ACTIVE and related to nothing. Narrowing one relationship
    // must not have widened another.
    expect(await visibleKeys(await reload(firm.users.chandra))).toEqual([]);
  });
});

// ──────────────────────────────────────────── C: existing standing survives

describe("an existing membership is never downgraded", () => {
  it("a MEMBER stays a MEMBER and keeps engagement-wide visibility", async () => {
    // Eshan is already a MEMBER of EngA1. Meera giving him another task there
    // must not quietly reclassify him and take away access he holds properly.
    await createTask(
      actor.meera!,
      createTaskSchema.parse({
        title: "Reconcile the TDS ledger",
        engagementId: firm.engagements.a1.toString(),
        assigneeId: firm.users.eshan.toString(),
        dueDate: "2026-12-31",
      })
    );

    const membership = await capacityOn(firm.engagements.a1, firm.users.eshan);
    expect(membership?.capacity).toBe(EngagementCapacity.MEMBER);

    // And the engagement-wide read that MEMBER confers is intact: t2 is not
    // his task, and he could always see it.
    expect(await visibleKeys(await reload(firm.users.eshan))).toContain("TSK-TEST-0002");
  });

  it("a MANAGER stays a MANAGER", async () => {
    // The worst version of a downgrade bug: a Staff member assigns a task to
    // the engagement manager and strips her capacity in passing.
    await createTask(
      actor.eshan!,
      createTaskSchema.parse({
        title: "Sign off the computation",
        engagementId: firm.engagements.a1.toString(),
        assigneeId: firm.users.meera.toString(),
        dueDate: "2026-12-31",
      })
    );

    const membership = await capacityOn(firm.engagements.a1, firm.users.meera);
    expect(membership?.capacity).toBe(EngagementCapacity.MANAGER);
  });

  it("upgrades nothing either — reassigning to an observer leaves them an observer", async () => {
    const task = await requestWorkFromEllie();

    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.esha,
    });
    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.ellie,
    });

    const membership = await capacityOn(firm.engagements.a1, firm.users.ellie);
    expect(membership?.capacity).toBe(EngagementCapacity.OBSERVER);
  });
});

// ──────────────────────────────────────────── D: she can actually do the work

describe("the borrowed specialist can do the work", () => {
  it("finds it in My Work", async () => {
    const task = await requestWorkFromEllie();

    const work = await getMyWork(await reload(firm.users.ellie));
    const keys = work.bands.flatMap((b) => b.tasks.map((t) => t.displayKey));
    expect(keys).toContain(task.displayKey);
  });

  it("can log time against it", async () => {
    const task = await requestWorkFromEllie();
    const workDate = new Date();
    workDate.setUTCHours(0, 0, 0, 0);

    await logManualTime(await reload(firm.users.ellie), {
      taskId: task.id,
      workDate,
      minutes: 90,
    });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.actualMinutes).toBe(90);
  });

  it("can comment on it", async () => {
    const task = await requestWorkFromEllie();

    const comment = await addComment(await reload(firm.users.ellie), task.id, {
      bodyMd: "Pivot is ready — one supplier code looks wrong.",
    });
    expect(comment.author.id).toBe(firm.users.ellie);
  });

  it("can move it through the transitions an assignee owns", async () => {
    const task = await requestWorkFromEllie();

    const moved = await transitionTask(await reload(firm.users.ellie), task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
    });
    expect(moved.task.status).toBe(TaskStatus.IN_PROGRESS);
  });
});

// ──────────────────────────────────────────── E: no authority comes with it

describe("requesting work confers no authority over it", () => {
  it("the requester cannot reassign the task he created", async () => {
    const task = await requestWorkFromEllie();

    await expect(
      assignTask(actor.eshan!, task.id, {
        expectedVersion: await versionOf(task.id),
        assigneeId: firm.users.esha,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot move its deadline", async () => {
    const task = await requestWorkFromEllie();

    await expect(
      updateTask(actor.eshan!, task.id, {
        expectedVersion: await versionOf(task.id),
        dueDate: new Date("2027-01-31T00:00:00.000Z"),
        reason: "needs longer",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot change its priority", async () => {
    const task = await requestWorkFromEllie();

    await expect(
      updateTask(actor.eshan!, task.id, {
        expectedVersion: await versionOf(task.id),
        priority: "CRITICAL",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot cancel it", async () => {
    const task = await requestWorkFromEllie();

    await expect(
      transitionTask(actor.eshan!, task.id, {
        expectedVersion: await versionOf(task.id),
        to: TaskStatus.CANCELLED,
        reason: "changed my mind",
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("cannot log time against work he is not doing", async () => {
    // Creating a task is not a relationship to the WORK. Hours must belong to
    // whoever actually worked them, or the ledger stops meaning anything.
    const task = await requestWorkFromEllie();
    const workDate = new Date();
    workDate.setUTCHours(0, 0, 0, 0);

    await expect(
      logManualTime(actor.eshan!, { taskId: task.id, workDate, minutes: 30 })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gains no engagement he did not already have", async () => {
    const before = actor.eshan!.engagementIds.map(String).sort();
    await requestWorkFromEllie();
    const after = (await reload(firm.users.eshan)).engagementIds.map(String).sort();

    expect(after).toEqual(before);
  });
});
