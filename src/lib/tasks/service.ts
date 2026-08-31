import {
  ActivityAction,
  EngagementCapacity,
  NotificationType,
  Prisma,
  TaskStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordActivity, type ActivityInput, type Tx } from "@/lib/activity/log";
import { notify } from "@/lib/notifications/service";
import { getCurrentOrganization } from "@/lib/org/current";
import { localWorkDate } from "@/lib/time/service";
import {
  assertPermitted,
  canCreateTask,
  canManageTask,
  canWriteField,
  ForbiddenError,
  hasUnrestrictedTaskVisibility,
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
      // The engagement's own name, alongside the client's. Added when the
      // browse screen needed to render a row and could only say which CLIENT
      // it belonged to — "ORCHID — ?" is not a useful line. One extra column
      // on a join that was already happening.
      name: true,
      partnerId: true,
      managerId: true,
      status: true,
      defaultReviewRequired: true,
      team: { select: { membersCanCreateTasks: true } },
      client: { select: { id: true, name: true, code: true } },
    },
  },
  // Likewise: every list of tasks that spans more than one person has to say
  // whose each one is. Carrying only assigneeId meant each caller resolved
  // names itself, which is a join per caller instead of one here.
  assignee: { select: { id: true, name: true } },
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
        externalDeadline: input.externalDeadline ?? null,
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

    // Same transaction as the assignment itself. Enqueued instead, a crash
    // between the two leaves work on someone's plate with nobody told.
    await notify(tx, {
      userId: input.assigneeId,
      actorId: user.id,
      type: NotificationType.ASSIGNED_TO_ME,
      taskId: task.id,
      payload: { dueDate: task.dueDate.toISOString() },
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
  change("externalDeadline", input.externalDeadline, task.externalDeadline);
  change("reviewerId", input.reviewerId, task.reviewerId);
  change("currentEstimateMinutes", input.currentEstimateMinutes, task.currentEstimateMinutes);

  if (input.dueDate !== undefined && input.dueDate.getTime() !== task.dueDate.getTime()) {
    // A deadline is a commitment. Moving one without saying why is how a
    // history becomes useless six months later.
    if (!input.reason?.trim()) {
      throw new InvalidOperationError("Moving a deadline requires a reason.");
    }
    const ceiling = input.externalDeadline ?? task.externalDeadline;
    if (ceiling && input.dueDate > ceiling) {
      throw new InvalidOperationError(
        "The due date cannot be moved past the external deadline."
      );
    }
    change("dueDate", input.dueDate, task.dueDate);
  }

  if (input.reviewRequired !== undefined && input.reviewRequired !== task.reviewRequired) {
    assertPermitted(canManageTask(user, ctx), "change the review requirement");
    data.reviewRequired = input.reviewRequired;
  }

  if (Object.keys(data).length === 0) return task;

  const dueDateMoved = data.dueDate !== undefined;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: task.id },
      data,
      include: taskWithContext,
    });
    for (const a of activities) await recordActivity(tx, a);

    // A moved deadline is the one field change worth interrupting someone for:
    // it changes what they should be doing today. Title, priority and estimate
    // edits are visible when they next open the task and notify nobody.
    if (dueDateMoved) {
      await notify(tx, {
        userId: task.assigneeId,
        actorId: user.id,
        type: NotificationType.DUE_DATE_CHANGED,
        taskId: task.id,
        payload: {
          from: task.dueDate.toISOString(),
          to: (data.dueDate as Date).toISOString(),
          reason: input.reason ?? null,
        },
      });
    }

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

    // Only the person receiving the work. The person losing it already knows —
    // either they handed it over, or their manager told them, and a bell
    // saying "this is no longer yours" is a notification nobody acts on.
    await notify(tx, {
      userId: input.assigneeId,
      actorId: user.id,
      type: NotificationType.ASSIGNED_TO_ME,
      taskId: task.id,
      payload: { reason: input.reason ?? null },
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

    // Only two transitions put a ball in someone else's court, and only those
    // two notify. Completion, cancellation and starting work are all visible
    // on the screens people already look at; a bell for every status change
    // is how the bell stops being read.
    if (action === ActivityAction.SUBMITTED_FOR_REVIEW && task.reviewerId) {
      await notify(tx, {
        userId: task.reviewerId,
        actorId: user.id,
        type: NotificationType.REVIEW_REQUESTED,
        taskId: task.id,
      });
    }

    if (action === ActivityAction.REVIEW_REJECTED) {
      // Sent back with a reason the assignee has to act on. This one matters
      // most: work sitting rejected and unseen is the failure people notice.
      await notify(tx, {
        userId: task.assigneeId,
        actorId: user.id,
        type: NotificationType.REVIEW_REJECTED,
        taskId: task.id,
        payload: { reason: input.reason ?? null },
      });
    }

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

    await notify(tx, {
      userId,
      actorId: user.id,
      type: NotificationType.ADDED_AS_CONTRIBUTOR,
      taskId: task.id,
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

/**
 * Task ids matching a free-text search, most relevant first.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Raw SQL because the column is a `tsvector`, which Prisma models as
 * `Unsupported` and cannot query. The GIN index on it has existed since Stage
 * 1 and, until now, nothing had ever used it.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it understands quoted
 * phrases and `-exclusion`, which is what people type without being taught,
 * and it never throws on malformed input — `plainto_tsquery` does, which would
 * turn a stray quote into a 500.
 *
 * The organisation's `searchLanguage` drives stemming, so "filing" matches
 * "filed". It is configuration rather than a literal because a firm operating
 * in another language should not need a code change.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CAPPED — AND THE CAP IS APPLIED INSIDE THE CALLER'S SCOPE, NOT OUTSIDE IT.
 *
 * This is the whole point of the `scopeIds` parameter, and it was a real
 * defect before it existed. The query used to run across every task in the
 * firm, rank the matches, and keep the top 500; `listTasks` then intersected
 * that with `visibleTaskFilter`. So the cap was spent on rows the caller was
 * never allowed to see.
 *
 * The consequence was silent and got worse with data volume: once more than
 * 500 tasks matched a common term, the top 500 firm-wide could contain none of
 * the searcher's own work, and their task simply vanished from the results
 * with nothing to indicate it had been dropped. Never a disclosure — the
 * kernel still filtered what came back — but a staff member searching "GSTR"
 * could get an empty page for a task assigned to them.
 *
 * `scopeIds` is the id set the caller has ALREADY resolved through the
 * permission kernel. This function does not decide who may see what and must
 * never learn how to: it narrows a set it is handed. `null` means "no
 * narrowing needed", which the caller uses only when the kernel says the
 * user's visibility is unrestricted.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function searchTaskIds(
  query: string,
  language: string,
  /** Ids the caller may see, already resolved by the kernel. `null` = all. */
  scopeIds: bigint[] | null
): Promise<bigint[]> {
  // `= ANY($1::bigint[])` rather than an expanded `IN (...)` list: one bind
  // parameter instead of one per id, so a wide scope cannot walk into
  // PostgreSQL's 65,535-parameter ceiling.
  const inScope = scopeIds === null
    ? Prisma.sql`TRUE`
    : Prisma.sql`id = ANY(${scopeIds}::bigint[])`;

  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
      FROM tasks
     WHERE ${inScope}
       AND search_vector @@ websearch_to_tsquery(${language}::regconfig, ${query})
       AND deleted_at IS NULL
     ORDER BY ts_rank(search_vector, websearch_to_tsquery(${language}::regconfig, ${query})) DESC
     LIMIT 500
  `;
  return rows.map((r) => r.id);
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

  const org = await getCurrentOrganization();

  if (filters.overdue) {
    // The ORGANISATION's today, not the server's. Using UTC here made work
    // stop counting as overdue for the five and a half hours each evening
    // when it is already tomorrow in IST but still today in UTC — silently,
    // and only in the evening, which is the hardest kind of wrong to notice.
    const today = localWorkDate(new Date(), org.timezone);
    where.push({
      dueDate: { lt: today },
      status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
    });
  }

  if (filters.search) {
    // ── Search runs LAST, inside the scope every other clause has built ─────
    //
    // Placement is the fix, not decoration. `where` already holds
    // `visibleTaskFilter` and every other filter, so resolving the scope here
    // means the search's 500-row cap is spent on rows this caller would
    // actually have received. Resolving it earlier would reinstate the defect.
    //
    // The scope query is the KERNEL'S OWN predicate, run as-is. No visibility
    // rule is restated here, and none should ever be: if the union of
    // relationships changes in permissions.ts, this picks it up for free.
    //
    // `where` holds exactly one clause when nothing narrows: `visibleTaskFilter`
    // is pushed first and every other filter pushes onto it. Combined with an
    // unrestricted user, that means enumerating the scope would cost a full
    // scan to arrive at the same answer. `visibleTaskFilter` is still composed
    // into the query below — the kernel stays in the path; only the redundant
    // work is skipped.
    const nothingNarrowsTheScope =
      hasUnrestrictedTaskVisibility(user) && where.length === 1;

    const scopeIds = nothingNarrowsTheScope
      ? null
      : await prisma.task
          .findMany({ where: { AND: where }, select: { id: true } })
          .then((rows) => rows.map((r) => r.id));

    // Previously declared in the schema and silently ignored here — a caller
    // asking for "GSTR" received everything and had no way to know.
    const ids = await searchTaskIds(filters.search, org.searchLanguage, scopeIds);

    // No matches must mean NO RESULTS. An empty `in: []` is what Prisma needs
    // to say that; omitting the clause entirely would hand back the unfiltered
    // list, which is the original bug wearing a different hat.
    where.push({ id: { in: ids } });
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
