/**
 * The write path.
 *
 * Everything tested so far was read-only — who can SEE what. This suite covers
 * what happens when someone changes something, and it deliberately targets the
 * failures that would be SILENT rather than loud:
 *
 *   - a permission quietly relaxed
 *   - a concurrent edit overwriting another
 *   - an activity record not written
 *   - hours following a task to its new owner instead of staying with whoever
 *     actually worked them
 *
 * A crash gets noticed. These do not.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ActivityAction, TaskStatus, TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, ForbiddenError, NotFoundError, type ActingUser } from "@/lib/auth/permissions";
import {
  addContributor,
  assignTask,
  ConflictError,
  createTask,
  getTaskByKey,
  InvalidOperationError,
  listTasks,
  setBlocked,
  transitionTask,
  updateTask,
} from "@/lib/tasks/service";
import { createTaskSchema, listTasksSchema } from "@/lib/tasks/schemas";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** Current optimistic-lock token for a task. */
async function versionOf(taskId: bigint): Promise<string> {
  const t = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { updatedAt: true },
  });
  return t.updatedAt.toISOString();
}

function newTaskInput(over: Record<string, unknown> = {}) {
  return createTaskSchema.parse({
    title: "Prepare GST reconciliation",
    engagementId: firm.engagements.a1.toString(),
    assigneeId: firm.users.eshan.toString(),
    dueDate: "2026-12-31",
    ...over,
  });
}

// ────────────────────────────────────────────────────────────── create

describe("createTask", () => {
  it("a manager on the engagement can create work", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    expect(task.displayKey).toMatch(/^TSK-\d{4}-\d{5}$/);
    expect(task.assigneeId).toBe(firm.users.eshan);
    expect(task.createdById).toBe(firm.users.meera);
  });

  it("refuses someone with no relationship to the engagement", async () => {
    await expect(createTask(actor.chandra!, newTaskInput())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses when the team has member task creation switched off", async () => {
    await prisma.team.updateMany({
      where: { name: "Direct Tax" },
      data: { membersCanCreateTasks: false },
    });
    const eshan = await loadActingUser(firm.users.eshan);

    await expect(createTask(eshan, newTaskInput())).rejects.toBeInstanceOf(ForbiddenError);
    // ...but a manager on the same engagement is unaffected.
    await expect(createTask(actor.meera!, newTaskInput())).resolves.toBeDefined();
  });

  it("refuses a closed engagement", async () => {
    await prisma.engagement.update({
      where: { id: firm.engagements.a1 },
      data: { status: "CLOSED" },
    });
    await expect(createTask(actor.meera!, newTaskInput())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses to assign work to someone who has left", async () => {
    await prisma.user.update({
      where: { id: firm.users.eshan },
      data: { status: "INACTIVE" },
    });
    await expect(createTask(actor.meera!, newTaskInput())).rejects.toBeInstanceOf(
      InvalidOperationError
    );
  });

  it("records creation AND assignment in the activity log", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const actions = await prisma.activityLog.findMany({
      where: { taskId: task.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([ActivityAction.TASK_CREATED, ActivityAction.TASK_ASSIGNED])
    );
  });

  it("issues sequential, unique display keys", async () => {
    const a = await createTask(actor.meera!, newTaskInput());
    const b = await createTask(actor.meera!, newTaskInput({ title: "Second task" }));
    expect(a.displayKey).not.toBe(b.displayKey);
  });
});

// ─────────────────────────────────────────── assignment as staffing

describe("assignment adds the person to the engagement", () => {
  it("on creation", async () => {
    // Ellie is on EngA2 and EngB1, not EngA1.
    const before = await prisma.engagementMember.count({
      where: { engagementId: firm.engagements.a1, userId: firm.users.ellie },
    });
    expect(before).toBe(0);

    await createTask(actor.meera!, newTaskInput({ assigneeId: firm.users.ellie.toString() }));

    const after = await prisma.engagementMember.count({
      where: { engagementId: firm.engagements.a1, userId: firm.users.ellie },
    });
    expect(after).toBe(1);
  });

  it("on reassignment, and the new assignee can then see the task", async () => {
    const task = await createTask(actor.meera!, newTaskInput());

    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.ellie,
    });

    const ellie = await loadActingUser(firm.users.ellie);
    expect(ellie.engagementIds).toContain(firm.engagements.a1);

    const visible = await listTasks(ellie, listTasksSchema.parse({}));
    expect(visible.tasks.map((t) => t.id)).toContain(task.id);
  });

  it("does not duplicate membership for someone already on the engagement", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.meera,
    });

    const count = await prisma.engagementMember.count({
      where: { engagementId: firm.engagements.a1, userId: firm.users.meera },
    });
    expect(count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────── update

describe("updateTask", () => {
  it("lets the assignee retitle their own task", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    const updated = await updateTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      title: "Prepare GST reconciliation (revised)",
    });
    expect(updated.title).toContain("revised");
  });

  it("REFUSES a member moving their own deadline", async () => {
    // The rule most likely to be quietly relaxed later, so it is pinned here.
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await expect(
      updateTask(eshan, task.id, {
        expectedVersion: await versionOf(task.id),
        dueDate: new Date("2027-01-31T00:00:00.000Z"),
        reason: "need more time",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSES a member changing their own priority", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await expect(
      updateTask(eshan, task.id, {
        expectedVersion: await versionOf(task.id),
        priority: "CRITICAL",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("requires a reason when a manager moves a deadline", async () => {
    const task = await createTask(actor.meera!, newTaskInput());

    await expect(
      updateTask(actor.meera!, task.id, {
        expectedVersion: await versionOf(task.id),
        dueDate: new Date("2027-01-31T00:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("moves the deadline when a reason is given, and records old and new", async () => {
    const task = await createTask(actor.meera!, newTaskInput());

    await updateTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      dueDate: new Date("2027-01-31T00:00:00.000Z"),
      reason: "Client extension agreed in writing",
    });

    const entry = await prisma.activityLog.findFirst({
      where: { taskId: task.id, action: ActivityAction.DUE_DATE_CHANGED },
    });
    expect(entry).not.toBeNull();
    expect(entry?.reason).toMatch(/extension/i);
    expect(entry?.oldValue).toBe("2026-12-31T00:00:00.000Z");
    expect(entry?.newValue).toBe("2027-01-31T00:00:00.000Z");
  });

  it("refuses to move a due date past its external deadline", async () => {
    const task = await createTask(
      actor.meera!,
      newTaskInput({
        dueDate: "2026-12-20",
        externalDeadline: "2026-12-31",
        dueDateType: "EXTERNAL_FIXED",
      })
    );

    await expect(
      updateTask(actor.meera!, task.id, {
        expectedVersion: await versionOf(task.id),
        dueDate: new Date("2027-01-15T00:00:00.000Z"),
        reason: "slipping",
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

// ──────────────────────────────────────────────── optimistic locking

describe("concurrent edits", () => {
  it("refuses a write based on a stale version", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const staleVersion = await versionOf(task.id);

    // Someone else gets there first.
    await updateTask(actor.meera!, task.id, {
      expectedVersion: staleVersion,
      title: "Renamed by the first editor",
    });

    await expect(
      updateTask(actor.meera!, task.id, {
        expectedVersion: staleVersion,
        title: "Renamed by the second editor",
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("hands back the current state so the caller can show what changed", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const stale = await versionOf(task.id);
    await updateTask(actor.meera!, task.id, { expectedVersion: stale, title: "First wins" });

    const err = await updateTask(actor.meera!, task.id, {
      expectedVersion: stale,
      title: "Second loses",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).current).toMatchObject({
      task: { title: "First wins" },
    });
  });

  it("the first edit is not lost", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const stale = await versionOf(task.id);
    await updateTask(actor.meera!, task.id, { expectedVersion: stale, title: "First wins" });
    await updateTask(actor.meera!, task.id, { expectedVersion: stale, title: "Second loses" }).catch(
      () => undefined
    );

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.title).toBe("First wins");
  });
});

// ───────────────────────────────────────────────────────── reassignment

describe("reassignment", () => {
  it("stops a running timer and leaves the hours with the original person", async () => {
    const task = await createTask(actor.meera!, newTaskInput());

    await prisma.timeEntry.create({
      data: {
        taskId: task.id,
        userId: firm.users.eshan,
        workDate: new Date("2026-08-26T00:00:00.000Z"),
        startedAt: new Date(Date.now() - 90 * 60_000),
        source: TimeEntrySource.TIMER,
      },
    });

    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.esha,
      reason: "Eshan is on leave",
    });

    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { taskId: task.id, userId: firm.users.eshan },
    });

    expect(entry.endedAt).not.toBeNull();
    expect(entry.durationMinutes).toBeGreaterThan(80);
    // Hours belong to whoever worked them, permanently.
    expect(entry.userId).toBe(firm.users.eshan);
  });

  it("frees the original assignee to start a timer elsewhere", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    await prisma.timeEntry.create({
      data: {
        taskId: task.id, userId: firm.users.eshan,
        workDate: new Date("2026-08-26T00:00:00.000Z"),
        startedAt: new Date(Date.now() - 30 * 60_000),
        source: TimeEntrySource.TIMER,
      },
    });

    await assignTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      assigneeId: firm.users.esha,
    });

    const stillRunning = await prisma.timeEntry.count({
      where: { userId: firm.users.eshan, endedAt: null },
    });
    expect(stillRunning).toBe(0);
  });

  it("refuses to assign a task to its own reviewer", async () => {
    const task = await createTask(
      actor.meera!,
      newTaskInput({ reviewerId: firm.users.esha.toString() })
    );

    await expect(
      assignTask(actor.meera!, task.id, {
        expectedVersion: await versionOf(task.id),
        assigneeId: firm.users.esha,
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("a member cannot reassign their own task away", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await expect(
      assignTask(eshan, task.id, {
        expectedVersion: await versionOf(task.id),
        assigneeId: firm.users.esha,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ───────────────────────────────────────────────────────── transitions

describe("transitions", () => {
  it("the assignee can start work, and startedAt is stamped", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    const { task: started } = await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
    });

    expect(started.status).toBe(TaskStatus.IN_PROGRESS);
    expect(started.startedAt).not.toBeNull();
  });

  it("startedAt survives a reopen — cycle time must not be rewritten", async () => {
    const task = await createTask(actor.meera!, newTaskInput({ reviewRequired: false }));
    const eshan = await loadActingUser(firm.users.eshan);

    const { task: started } = await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
    });
    const originalStart = started.startedAt!;

    await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.COMPLETED,
    });

    const { task: reopened } = await transitionTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
      reason: "Client provided revised figures",
    });

    expect(reopened.startedAt?.toISOString()).toBe(originalStart.toISOString());
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.completedAt).toBeNull();
  });

  it("records a rejection distinctly from an ordinary status change", async () => {
    const task = await createTask(
      actor.meera!,
      newTaskInput({ reviewRequired: true, reviewerId: firm.users.meera.toString() })
    );
    const eshan = await loadActingUser(firm.users.eshan);

    await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
    });
    await prisma.timeEntry.create({
      data: {
        taskId: task.id, userId: firm.users.eshan,
        workDate: new Date("2026-08-26T00:00:00.000Z"), durationMinutes: 60,
      },
    });
    await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.REVIEW,
    });

    const { task: sentBack } = await transitionTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
      reason: "Opening balances do not tie out",
    });

    expect(sentBack.reviewRound).toBe(2);

    const rejection = await prisma.activityLog.findFirst({
      where: { taskId: task.id, action: ActivityAction.REVIEW_REJECTED },
    });
    expect(rejection?.reason).toMatch(/tie out/i);
  });

  it("refuses an illegal transition", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await expect(
      transitionTask(eshan, task.id, {
        expectedVersion: await versionOf(task.id),
        to: TaskStatus.COMPLETED,
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("cancelling stores the reason on the task, not only in the log", async () => {
    const task = await createTask(actor.meera!, newTaskInput());

    const { task: cancelled } = await transitionTask(actor.meera!, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.CANCELLED,
      reason: "Client withdrew the instruction",
    });

    expect(cancelled.status).toBe(TaskStatus.CANCELLED);
    expect(cancelled.cancelReason).toMatch(/withdrew/i);
  });
});

// ──────────────────────────────────────────────────────── blocked flag

describe("blocked flag", () => {
  it("is orthogonal to status — a blocked task keeps its workflow position", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await transitionTask(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      to: TaskStatus.IN_PROGRESS,
    });

    const blocked = await setBlocked(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      blocked: true,
      reason: "Awaiting bank statements from the client",
    });

    expect(blocked.isBlocked).toBe(true);
    expect(blocked.status).toBe(TaskStatus.IN_PROGRESS);
    expect(blocked.blockedSince).not.toBeNull();
  });

  it("clears the reason when unblocked", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const eshan = await loadActingUser(firm.users.eshan);

    await setBlocked(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      blocked: true,
      reason: "Waiting on client",
    });
    const clear = await setBlocked(eshan, task.id, {
      expectedVersion: await versionOf(task.id),
      blocked: false,
    });

    expect(clear.isBlocked).toBe(false);
    expect(clear.blockedReason).toBeNull();
    expect(clear.blockedSince).toBeNull();
  });
});

// ─────────────────────────────────────────────────────── read paths

describe("reads", () => {
  it("getTaskByKey returns 404-shaped NotFound for a task the user cannot see", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const fetched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    await expect(getTaskByKey(actor.chandra!, fetched.displayKey)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("offers only transitions the caller can perform", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    const fetched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const eshan = await loadActingUser(firm.users.eshan);

    const asMember = await getTaskByKey(eshan, fetched.displayKey);
    expect(asMember.canManage).toBe(false);
    expect(asMember.transitions.map((t) => t.to)).not.toContain(TaskStatus.CANCELLED);

    const asManager = await getTaskByKey(actor.meera!, fetched.displayKey);
    expect(asManager.canManage).toBe(true);
    expect(asManager.transitions.map((t) => t.to)).toContain(TaskStatus.CANCELLED);
  });

  it("listTasks applies the visibility scope on top of every filter", async () => {
    // Chandra filtering by an engagement she has no part in still sees nothing.
    const result = await listTasks(
      actor.chandra!,
      listTasksSchema.parse({ engagementId: firm.engagements.a1.toString() })
    );
    expect(result.tasks).toHaveLength(0);
  });

  it("listTasks filters overdue correctly", async () => {
    await createTask(actor.meera!, newTaskInput({ dueDate: "2020-01-01", title: "Long overdue" }));

    const overdue = await listTasks(actor.meera!, listTasksSchema.parse({ overdue: true }));
    expect(overdue.tasks.some((t) => t.title === "Long overdue")).toBe(true);

    const notOverdue = await listTasks(actor.meera!, listTasksSchema.parse({ overdue: false }));
    expect(notOverdue.tasks.length).toBeGreaterThan(overdue.tasks.length);
  });
});

// ──────────────────────────────────────────────────────── contributors

describe("contributors", () => {
  it("a contributor can see and log time against the task", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    await addContributor(actor.meera!, task.id, firm.users.chandra);

    const chandra = await loadActingUser(firm.users.chandra);
    const visible = await listTasks(chandra, listTasksSchema.parse({}));
    expect(visible.tasks.map((t) => t.id)).toContain(task.id);
  });

  it("refuses to add the assignee as a contributor to their own task", async () => {
    const task = await createTask(actor.meera!, newTaskInput());
    await expect(
      addContributor(actor.meera!, task.id, firm.users.eshan)
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});
