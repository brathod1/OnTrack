import { ActivityAction, EngagementCapacity, Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordActivity, type ActivityInput, type Tx } from "@/lib/activity/log";
import {
  assertPermitted,
  canCreateTask,
  canManageTask,
  canWriteField,
  ForbiddenError,
  NotFoundError,
  visibleTaskFilter,
  type ActingUser,
  type TaskWriteContext,
  type WritableField,
} from "@/lib/auth/permissions";
import {
  availableTransitions,
  resolveTransition,
  transitionSideEffects,
  type TransitionFacts,
} from "./transitions";
import type {
  CreateTaskInput,
  ListTasksInput,
  UpdateTaskInput,
} from "./schemas";

// Defined in @/lib/errors so the HTTP layer can map them without importing
// this module (and with it, Prisma). Re-exported for existing callers.
import { ConflictError, InvalidOperationError } from "@/lib/errors";
export { ConflictError, InvalidOperationError };

// ── Loading ─────────────────────────────────────────────────────────────────

const taskWithContext = {
  engagement: {
    select: {
      id: true,
      partnerId: true,
      managerId: true,
      status: true,
      defaultReviewRequired: true,
      team: { select: { membersCanCreateTasks: true } },
      client: { select: { id: true, name: true, code: true } },
    },
  },
  contributors: { select: { userId: true } },
  _count: { select: { subtasks: { where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } } } },
} satisfies Prisma.TaskInclude;

type LoadedTask = Prisma.TaskGetPayload<{ include: typeof taskWithContext }>;

/**
 * Load a task the acting user is permitted to see.
 *
 * Composes `visibleTaskFilter` rather than fetching by id and checking after,
 * so a task the user may not see is simply not found — 404, never 403. A 403
 * confirms the record exists, which is what someone probing ids wants to learn.
 */
async function loadVisibleTask(user: ActingUser, taskId: bigint): Promise<LoadedTask> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, visibleTaskFilter(user)] },
    include: taskWithContext,
  });
  if (!task) throw new NotFoundError("Task");
  return task;
}

function writeContext(task: LoadedTask, viewerId: bigint): TaskWriteContext {
  return {
    assigneeId: task.assigneeId,
    createdById: task.createdById,
    assignedById: task.assignedById,
    reviewerId: task.reviewerId,
    engagementId: task.engagementId,
    status: task.status,
    isContributor: task.contributors.some((c) => c.userId === viewerId),
    engagementPartnerId: task.engagement.partnerId,
    engagementManagerId: task.engagement.managerId,
  };
}

/**
 * Optimistic locking.
 *
 * Two managers editing one task is rare but real, especially near a deadline.
 * Last-write-wins loses a deadline change with nobody aware it happened; this
 * refuses the stale write and hands back the current state so the caller can
 * show what changed underneath them.
 */
function assertVersion(task: LoadedTask, expected: string): void {
  const actual = task.updatedAt.toISOString();
  if (actual !== expected) {
    throw new ConflictError(
      "This task was changed by someone else while you were editing it.",
      { currentVersion: actual, task: { title: task.title, status: task.status } }
    );
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createTask(user: ActingUser, input: CreateTaskInput) {
  const engagement = await prisma.engagement.findUnique({
    where: { id: input.engagementId },
    select: {
      id: true, partnerId: true, managerId: true, status: true,
      defaultReviewRequired: true,
      team: { select: { membersCanCreateTasks: true } },
    },
  });
  if (!engagement) throw new NotFoundError("Engagement");

  assertPermitted(
    canCreateTask(user, {
      engagementId: engagement.id,
      partnerId: engagement.partnerId,
      managerId: engagement.managerId,
      membersCanCreateTasks: engagement.team?.membersCanCreateTasks ?? true,
      isActive: engagement.status === "ACTIVE",
    }),
    "create a task on this engagement"
  );

  const assignee = await prisma.user.findUnique({
    where: { id: input.assigneeId },
    select: { id: true, status: true, name: true },
  });
  if (!assignee) throw new NotFoundError("Assignee");
  if (assignee.status !== "ACTIVE") {
    throw new InvalidOperationError("That person is no longer active and cannot be assigned work.");
  }

  // Subtasks inherit their parent's engagement; depth is capped by a database
  // trigger, so a bad parent fails loudly rather than building a deep tree.
  if (input.parentTaskId) {
    const parent = await loadVisibleTask(user, input.parentTaskId);
    if (parent.engagementId !== input.engagementId) {
      throw new InvalidOperationError("A subtask must belong to the same engagement as its parent.");
    }
  }

  const reviewRequired = input.reviewRequired ?? engagement.defaultReviewRequired;
  if (reviewRequired && !input.reviewerId) {
    // Not fatal at creation — a reviewer must exist only when the work is
    // submitted. Blocking here would stop a manager creating twenty tasks
    // quickly and naming reviewers later.
  }

  return prisma.$transaction(async (tx) => {
    const keyRows = await tx.$queryRaw<{ key: string }[]>`SELECT next_task_key() AS key`;
    const key = keyRows[0]?.key;
    if (!key) throw new Error("next_task_key() returned nothing — is the migration applied?");

    const task = await tx.task.create({
      data: {
        displayKey: key,
        title: input.title,
        description: input.description ?? null,
        engagementId: input.engagementId,
        parentTaskId: input.parentTaskId ?? null,
        createdById: user.id,
        assignedById: user.id,
        assigneeId: input.assigneeId,
        reviewRequired,
        reviewerId: input.reviewerId ?? null,
        priority: input.priority,
        dueDate: input.dueDate,
        dueDateType: input.dueDateType,
        statutoryDueDate: input.statutoryDueDate ?? null,
        originalEstimateMinutes: input.estimateMinutes ?? null,
        currentEstimateMinutes: input.estimateMinutes ?? null,
      },
      include: taskWithContext,
    });

    if (input.tagIds?.length) {
      await tx.taskTag.createMany({
        data: input.tagIds.map((tagId) => ({ taskId: task.id, tagId })),
        skipDuplicates: true,
      });
    }

    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action: ActivityAction.TASK_CREATED,
      newValue: { title: task.title, assigneeId: task.assigneeId, dueDate: task.dueDate },
    });

    await ensureEngagementMembership(tx, task.engagementId, input.assigneeId, user.id);

    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action: ActivityAction.TASK_ASSIGNED,
      field: "assigneeId", newValue: input.assigneeId,
    });

    return task;
  });
}

/**
 * Assigning someone to a task puts them on the engagement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A judgement call, so it is worth stating plainly.
 *
 * The alternative rules are both worse. Refusing to assign non-members means
 * managers hit a wall constantly, because staffing changes daily and nobody
 * maintains a membership list in advance. Allowing it without membership
 * leaves someone holding one orphan task on an engagement they cannot
 * otherwise see — no context, no colleagues' work, no engagement view.
 *
 * In a firm, putting work on someone's plate IS staffing them. Doing it
 * implicitly keeps membership accurate with no one maintaining it, which is
 * what makes every engagement report truthful. It is logged as its own event,
 * so it is never silent.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function ensureEngagementMembership(
  tx: Tx,
  engagementId: bigint,
  userId: bigint,
  actorId: bigint
): Promise<void> {
  const existing = await tx.engagementMember.findFirst({
    where: {
      engagementId, userId,
      OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (existing) return;

  await tx.engagementMember.create({
    data: { engagementId, userId, capacity: EngagementCapacity.MEMBER },
  });

  await recordActivity(tx, {
    actorId, action: ActivityAction.CONTRIBUTOR_ADDED,
    field: "engagementMember", newValue: { engagementId, userId },
    reason: "added to the engagement automatically on assignment",
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/** Which activity action records a change to each field. */
const FIELD_ACTIONS: Partial<Record<WritableField, ActivityAction>> = {
  priority: ActivityAction.PRIORITY_CHANGED,
  dueDate: ActivityAction.DUE_DATE_CHANGED,
  currentEstimateMinutes: ActivityAction.ESTIMATE_CHANGED,
};

export async function updateTask(user: ActingUser, taskId: bigint, input: UpdateTaskInput) {
  const task = await loadVisibleTask(user, taskId);
  assertVersion(task, input.expectedVersion);

  const ctx = writeContext(task, user.id);
  const data: Prisma.TaskUpdateInput = {};
  const activities: ActivityInput[] = [];

  const change = <K extends WritableField>(
    field: K,
    next: unknown,
    current: unknown
  ) => {
    if (next === undefined) return;
    const same =
      next instanceof Date && current instanceof Date
        ? next.getTime() === current.getTime()
        : next === current;
    if (same) return;

    // Every field is checked BEFORE anything is written. A partial update
    // that half-applies is worse than a refusal.
    assertPermitted(canWriteField(user, ctx, field), `change ${field}`);

    (data as Record<string, unknown>)[field] = next;

    const action = FIELD_ACTIONS[field];
    if (action) {
      activities.push({
        taskId: task.id, actorId: user.id, action,
        field, oldValue: current, newValue: next, reason: input.reason ?? null,
      });
    }
  };

  change("title", input.title, task.title);
  change("description", input.description, task.description);
  change("priority", input.priority, task.priority);
  change("dueDateType", input.dueDateType, task.dueDateType);
  change("statutoryDueDate", input.statutoryDueDate, task.statutoryDueDate);
  change("reviewerId", input.reviewerId, task.reviewerId);
  change("currentEstimateMinutes", input.currentEstimateMinutes, task.currentEstimateMinutes);

  if (input.dueDate !== undefined && input.dueDate.getTime() !== task.dueDate.getTime()) {
    // A deadline is a commitment. Moving one without saying why is how a
    // history becomes useless six months later.
    if (!input.reason?.trim()) {
      throw new InvalidOperationError("Moving a deadline requires a reason.");
    }
    const ceiling = input.statutoryDueDate ?? task.statutoryDueDate;
    if (ceiling && input.dueDate > ceiling) {
      throw new InvalidOperationError(
        "The due date cannot be moved past the statutory deadline."
      );
    }
    change("dueDate", input.dueDate, task.dueDate);
  }

  if (input.reviewRequired !== undefined && input.reviewRequired !== task.reviewRequired) {
    assertPermitted(canManageTask(user, ctx), "change the review requirement");
    data.reviewRequired = input.reviewRequired;
  }

  if (Object.keys(data).length === 0) return task;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: task.id },
      data,
      include: taskWithContext,
    });
    for (const a of activities) await recordActivity(tx, a);
    return updated;
  });
}

// ── Assign ──────────────────────────────────────────────────────────────────

export async function assignTask(
  user: ActingUser,
  taskId: bigint,
  input: { expectedVersion: string; assigneeId: bigint; reason?: string }
) {
  const task = await loadVisibleTask(user, taskId);
  assertVersion(task, input.expectedVersion);

  const ctx = writeContext(task, user.id);
  assertPermitted(canWriteField(user, ctx, "assigneeId"), "reassign this task");

  if (input.assigneeId === task.assigneeId) return task;

  const next = await prisma.user.findUnique({
    where: { id: input.assigneeId },
    select: { id: true, status: true },
  });
  if (!next) throw new NotFoundError("Assignee");
  if (next.status !== "ACTIVE") {
    throw new InvalidOperationError("That person is no longer active and cannot be assigned work.");
  }
  if (task.reviewerId === input.assigneeId) {
    throw new InvalidOperationError("That person is the reviewer — nobody reviews their own work.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        assigneeId: input.assigneeId,
        assignedById: user.id,
        assignedAt: new Date(),
      },
      include: taskWithContext,
    });

    // Any timer the previous assignee left running on this task is stopped.
    // Leaving it would keep accruing hours against work they no longer own.
    const running = await tx.timeEntry.findFirst({
      where: { taskId: task.id, userId: task.assigneeId, endedAt: null, deletedAt: null },
    });
    if (running?.startedAt) {
      const minutes = Math.max(0, Math.round((Date.now() - running.startedAt.getTime()) / 60000));
      await tx.timeEntry.update({
        where: { id: running.id },
        data: { endedAt: new Date(), durationMinutes: minutes },
      });
      await recordActivity(tx, {
        taskId: task.id, actorId: user.id, action: ActivityAction.TIMER_STOPPED,
        reason: "stopped automatically on reassignment",
        newValue: { userId: task.assigneeId, minutes },
      });
    }

    await ensureEngagementMembership(tx, task.engagementId, input.assigneeId, user.id);

    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action: ActivityAction.TASK_REASSIGNED,
      field: "assigneeId",
      oldValue: task.assigneeId, newValue: input.assigneeId,
      reason: input.reason ?? null,
    });

    return updated;
  });
}

// ── Transition ──────────────────────────────────────────────────────────────

async function transitionFacts(task: LoadedTask): Promise<TransitionFacts> {
  const timeLogged = await prisma.timeEntry.count({
    where: { taskId: task.id, deletedAt: null },
  });
  return {
    openSubtaskCount: task._count.subtasks,
    hasTimeLogged: timeLogged > 0,
    reviewRequired: task.reviewRequired,
    reviewerId: task.reviewerId,
  };
}

export async function transitionTask(
  user: ActingUser,
  taskId: bigint,
  input: { expectedVersion: string; to: TaskStatus; reason?: string; override?: boolean }
) {
  const task = await loadVisibleTask(user, taskId);
  assertVersion(task, input.expectedVersion);

  const ctx = writeContext(task, user.id);
  const facts = { ...(await transitionFacts(task)), overrideGuards: input.override };

  const result = resolveTransition(user, ctx, facts, { to: input.to, reason: input.reason });
  if (!result.ok) throw new InvalidOperationError(result.error);

  const now = new Date();
  const patch = transitionSideEffects(result.rule, now) as Prisma.TaskUpdateInput;

  // startedAt is set once, on the first move into IN_PROGRESS. Reopening a
  // task must not rewrite when the work actually began.
  if (task.startedAt && "startedAt" in patch) delete (patch as Record<string, unknown>).startedAt;

  const action =
    input.to === TaskStatus.COMPLETED
      ? ActivityAction.TASK_COMPLETED
      : input.to === TaskStatus.CANCELLED
        ? ActivityAction.TASK_CANCELLED
        : input.to === TaskStatus.REVIEW
          ? ActivityAction.SUBMITTED_FOR_REVIEW
          : task.status === TaskStatus.REVIEW
            ? ActivityAction.REVIEW_REJECTED
            : task.status === TaskStatus.COMPLETED
              ? ActivityAction.TASK_REOPENED
              : ActivityAction.STATUS_CHANGED;

  if (input.to === TaskStatus.CANCELLED) patch.cancelReason = input.reason ?? null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: task.id },
      data: patch,
      include: taskWithContext,
    });

    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action,
      field: "status", oldValue: task.status, newValue: input.to,
      reason: input.reason ?? null,
    });

    return { task: updated, warnings: result.warnings };
  });
}

// ── Blocked flag ────────────────────────────────────────────────────────────

export async function setBlocked(
  user: ActingUser,
  taskId: bigint,
  input: { expectedVersion: string; blocked: boolean; reason?: string; expectedUnblockDate?: Date }
) {
  const task = await loadVisibleTask(user, taskId);
  assertVersion(task, input.expectedVersion);

  const ctx = writeContext(task, user.id);
  assertPermitted(canWriteField(user, ctx, "isBlocked"), "change the blocked flag");

  if (input.blocked === task.isBlocked) return task;
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) {
    throw new InvalidOperationError("A closed task cannot be blocked.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: task.id },
      data: input.blocked
        ? {
            isBlocked: true,
            blockedReason: input.reason ?? null,
            blockedSince: new Date(),
            expectedUnblockDate: input.expectedUnblockDate ?? null,
          }
        : {
            isBlocked: false,
            blockedReason: null,
            blockedSince: null,
            expectedUnblockDate: null,
          },
      include: taskWithContext,
    });

    await recordActivity(tx, {
      taskId: task.id, actorId: user.id,
      action: input.blocked ? ActivityAction.BLOCKED : ActivityAction.UNBLOCKED,
      field: "isBlocked", oldValue: task.isBlocked, newValue: input.blocked,
      reason: input.reason ?? null,
    });

    return updated;
  });
}

// ── Contributors ────────────────────────────────────────────────────────────

export async function addContributor(user: ActingUser, taskId: bigint, userId: bigint) {
  const task = await loadVisibleTask(user, taskId);
  const ctx = writeContext(task, user.id);
  assertPermitted(canWriteField(user, ctx, "contributors"), "add a contributor");

  if (userId === task.assigneeId) {
    throw new InvalidOperationError("The assignee already owns this task.");
  }

  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  });
  if (!person) throw new NotFoundError("User");
  if (person.status !== "ACTIVE") {
    throw new InvalidOperationError("That person is no longer active.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.taskContributor.upsert({
      where: { taskId_userId: { taskId: task.id, userId } },
      create: { taskId: task.id, userId, addedById: user.id },
      update: {},
    });
    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action: ActivityAction.CONTRIBUTOR_ADDED,
      field: "contributors", newValue: userId,
    });
    return loadVisibleTask(user, task.id);
  });
}

export async function removeContributor(user: ActingUser, taskId: bigint, userId: bigint) {
  const task = await loadVisibleTask(user, taskId);
  const ctx = writeContext(task, user.id);
  assertPermitted(canWriteField(user, ctx, "contributors"), "remove a contributor");

  return prisma.$transaction(async (tx) => {
    await tx.taskContributor.deleteMany({ where: { taskId: task.id, userId } });
    await recordActivity(tx, {
      taskId: task.id, actorId: user.id, action: ActivityAction.CONTRIBUTOR_REMOVED,
      field: "contributors", oldValue: userId,
    });
    return loadVisibleTask(user, task.id);
  });
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Resolve a human-quotable key (TSK-2026-00127) to an internal id.
 *
 * URLs carry the display key, not the numeric id. Two reasons: users quote
 * these keys in email and on calls, so a URL containing one is shareable and
 * meaningful; and a sequential integer in a URL advertises how much work the
 * firm does. Enumeration is already useless because of `visibleTaskFilter` —
 * this is defence in depth, not the defence.
 */
export async function resolveTaskIdByKey(user: ActingUser, displayKey: string): Promise<bigint> {
  const found = await prisma.task.findFirst({
    where: { AND: [{ displayKey }, visibleTaskFilter(user)] },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Task");
  return found.id;
}

export async function getTaskByKey(user: ActingUser, displayKey: string) {
  const found = await prisma.task.findFirst({
    where: { AND: [{ displayKey }, visibleTaskFilter(user)] },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Task");

  const task = await loadVisibleTask(user, found.id);
  const facts = await transitionFacts(task);
  const ctx = writeContext(task, user.id);

  return {
    task,
    /** Buttons the UI should offer. Never render an action the user cannot take. */
    transitions: availableTransitions(user, ctx, facts),
    canManage: canManageTask(user, ctx),
  };
}

export async function listTasks(user: ActingUser, filters: ListTasksInput) {
  const where: Prisma.TaskWhereInput[] = [visibleTaskFilter(user)];

  if (filters.engagementId) where.push({ engagementId: filters.engagementId });
  if (filters.clientId) where.push({ engagement: { clientId: filters.clientId } });
  if (filters.assigneeId) where.push({ assigneeId: filters.assigneeId });
  if (filters.assignedById) where.push({ assignedById: filters.assignedById });
  if (filters.reviewerId) where.push({ reviewerId: filters.reviewerId });
  if (filters.status?.length) where.push({ status: { in: filters.status } });
  if (filters.priority?.length) where.push({ priority: { in: filters.priority } });
  if (filters.dueDateType?.length) where.push({ dueDateType: { in: filters.dueDateType } });
  if (filters.blocked !== undefined) where.push({ isBlocked: filters.blocked });
  if (filters.dueBefore) where.push({ dueDate: { lte: filters.dueBefore } });
  if (filters.dueAfter) where.push({ dueDate: { gte: filters.dueAfter } });
  if (filters.tagIds?.length) where.push({ tags: { some: { tagId: { in: filters.tagIds } } } });

  if (filters.hasEstimate !== undefined) {
    where.push({ currentEstimateMinutes: filters.hasEstimate ? { not: null } : null });
  }

  if (filters.overdue) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    where.push({
      dueDate: { lt: today },
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
    });
  }

  const rows = await prisma.task.findMany({
    where: { AND: where },
    include: taskWithContext,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: filters.limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    tasks: page,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

export { ForbiddenError, NotFoundError };
