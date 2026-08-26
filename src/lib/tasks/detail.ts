import { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, visibleTaskFilter, canManageTask, type ActingUser } from "@/lib/auth/permissions";
import { availableTransitions, type TransitionFacts } from "./transitions";

/**
 * Everything one task detail page needs, in as few round trips as sensible.
 *
 * Loads through `visibleTaskFilter` rather than fetching by key and checking
 * afterwards, so a task the caller may not see is simply not found — the page
 * renders 404, identical to a task that does not exist.
 */

const detailSelect = {
  id: true,
  displayKey: true,
  title: true,
  description: true,
  status: true,
  priority: true,

  isBlocked: true,
  blockedReason: true,
  blockedSince: true,
  expectedUnblockDate: true,

  dueDate: true,
  dueDateType: true,
  externalDeadline: true,

  originalEstimateMinutes: true,
  currentEstimateMinutes: true,
  actualMinutes: true,

  reviewRequired: true,
  reviewRound: true,
  reopenCount: true,

  assignedAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,

  assignee: { select: { id: true, name: true, grade: true } },
  reviewer: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedBy: { select: { id: true, name: true } },

  parentTask: { select: { displayKey: true, title: true } },

  engagement: {
    select: {
      id: true,
      name: true,
      fy: true,
      partner: { select: { name: true } },
      manager: { select: { name: true } },
      client: { select: { id: true, name: true, code: true } },
    },
  },

  contributors: {
    select: {
      userId: true,
      addedAt: true,
      user: { select: { id: true, name: true } },
      addedBy: { select: { name: true } },
    },
    orderBy: { addedAt: "asc" },
  },

  subtasks: {
    select: {
      id: true,
      displayKey: true,
      title: true,
      status: true,
      dueDate: true,
      dueDateType: true,
      currentEstimateMinutes: true,
      actualMinutes: true,
      isBlocked: true,
      assignee: { select: { name: true } },
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  },

  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.TaskSelect;

export type TaskDetail = Prisma.TaskGetPayload<{ select: typeof detailSelect }>;

/** One row of the timeline, with the actor resolved. */
export type ActivityEntry = Prisma.ActivityLogGetPayload<{
  select: {
    id: true; action: true; field: true; oldValue: true; newValue: true;
    reason: true; actedAt: true;
    actor: { select: { id: true; name: true } };
  };
}>;

export interface TaskDetailResult {
  task: TaskDetail;
  activity: ActivityEntry[];
  /** Hours logged, split by person — review time is otherwise invisible. */
  timeByPerson: { userId: bigint; name: string; minutes: number }[];
  totalMinutes: number;
  canManage: boolean;
  transitions: ReturnType<typeof availableTransitions>;
}

const CLOSED: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED];

export async function getTaskDetail(
  user: ActingUser,
  displayKey: string
): Promise<TaskDetailResult> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ displayKey }, visibleTaskFilter(user)] },
    select: detailSelect,
  });

  if (!task) throw new NotFoundError("Task");

  const [activity, timeRows] = await Promise.all([
    prisma.activityLog.findMany({
      where: { taskId: task.id },
      select: {
        id: true, action: true, field: true, oldValue: true, newValue: true,
        reason: true, actedAt: true,
        actor: { select: { id: true, name: true } },
      },
      // Newest first: the question people arrive with is "what happened
      // recently", not "how did this begin".
      orderBy: [{ actedAt: "desc" }, { id: "desc" }],
      take: 200,
    }),

    prisma.timeEntry.groupBy({
      by: ["userId"],
      where: { taskId: task.id, deletedAt: null, isSuspended: false },
      _sum: { durationMinutes: true },
    }),
  ]);

  // groupBy cannot join, so resolve the names in one follow-up query.
  const names = timeRows.length
    ? await prisma.user.findMany({
        where: { id: { in: timeRows.map((r) => r.userId) } },
        select: { id: true, name: true },
      })
    : [];

  const timeByPerson = timeRows
    .map((r) => ({
      userId: r.userId,
      name: names.find((n) => n.id === r.userId)?.name ?? "Unknown",
      minutes: r._sum.durationMinutes ?? 0,
    }))
    .filter((r) => r.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);

  const ctx = {
    assigneeId: task.assignee.id,
    createdById: task.createdBy.id,
    assignedById: task.assignedBy?.id ?? null,
    reviewerId: task.reviewer?.id ?? null,
    engagementId: task.engagement.id,
    status: task.status,
    isContributor: task.contributors.some((c) => c.userId === user.id),
    engagementPartnerId: null as bigint | null,
    engagementManagerId: null as bigint | null,
  };

  // The engagement select above returns partner/manager NAMES for display;
  // the permission check needs their ids, so fetch them separately rather
  // than widening the display query with fields the page never renders.
  const engRoles = await prisma.engagement.findUnique({
    where: { id: task.engagement.id },
    select: { partnerId: true, managerId: true },
  });
  ctx.engagementPartnerId = engRoles?.partnerId ?? null;
  ctx.engagementManagerId = engRoles?.managerId ?? null;

  const facts: TransitionFacts = {
    openSubtaskCount: task.subtasks.filter((s) => !CLOSED.includes(s.status)).length,
    hasTimeLogged: timeRows.length > 0,
    reviewRequired: task.reviewRequired,
    reviewerId: task.reviewer?.id ?? null,
  };

  return {
    task,
    activity,
    timeByPerson,
    totalMinutes: timeByPerson.reduce((sum, r) => sum + r.minutes, 0),
    canManage: canManageTask(user, ctx),
    // Computed server-side so the UI renders buttons from this rather than
    // deciding for itself. Stage 9 wires them up.
    transitions: availableTransitions(user, ctx, facts),
  };
}
