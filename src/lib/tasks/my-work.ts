import { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ActingUser } from "@/lib/auth/permissions";

/**
 * "My Work" — the query behind the morning screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Deliberately NOT `visibleTaskFilter`. That answers "what may I see", which
 * for a manager is hundreds of tasks. This answers "what is on MY plate":
 * work where I am the assignee, a contributor, or the reviewer.
 *
 * The distinction matters. A manager who opens the app and sees every task on
 * four engagements has been given a report, not a to-do list, and will stop
 * opening it.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const OPEN_STATUSES = [
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.REVIEW,
] as const;

/** Start of today, UTC — matching how due_date is stored. */
export function today(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function daysFromToday(n: number): Date {
  const d = today();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const listSelect = {
  id: true,
  displayKey: true,
  title: true,
  status: true,
  priority: true,
  isBlocked: true,
  blockedReason: true,
  dueDate: true,
  dueDateType: true,
  currentEstimateMinutes: true,
  actualMinutes: true,
  reviewRound: true,
  assigneeId: true,
  reviewerId: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true } },
  engagement: {
    select: {
      id: true,
      name: true,
      client: { select: { id: true, name: true, code: true } },
    },
  },
  parentTaskId: true,
  // So a subtask can say what it belongs to. Without this they render as
  // siblings of their own parent, which is baffling in a flat list.
  parentTask: { select: { displayKey: true, title: true } },

  // The rows themselves rather than a _count, because we need TWO facts and
  // Prisma can only count a relation once per query: how many are still open
  // (shown on the row) and whether there are any at all (which decides
  // whether this task's estimate counts toward workload — see below).
  subtasks: {
    select: { id: true, status: true, currentEstimateMinutes: true, actualMinutes: true },
  },

  // `satisfies`, not `as const`. `as const` marks the nested arrays readonly,
  // which Prisma's generated types reject — and when the select fails to
  // typecheck, the inferred row type silently falls back to the bare model,
  // so every `task.engagement` downstream errors instead of the actual cause.
} satisfies Prisma.TaskSelect;

const CLOSED: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED];

export function openSubtaskCount(task: { subtasks: { status: TaskStatus }[] }): number {
  return task.subtasks.filter((s) => !CLOSED.includes(s.status)).length;
}

export function isParent(task: { subtasks: unknown[] }): boolean {
  return task.subtasks.length > 0;
}

export type MyWorkTask = Awaited<ReturnType<typeof fetchMyOpenTasks>>[number];

async function fetchMyOpenTasks(user: ActingUser) {
  return prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { in: [...OPEN_STATUSES] },
      OR: [
        { assigneeId: user.id },
        { contributors: { some: { userId: user.id } } },
        { reviewerId: user.id },
      ],
    },
    select: listSelect,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
}

/**
 * Why a task appears where it does in the list.
 *
 * Order is the whole point of this screen — see the note above about one list
 * rather than four widgets. These bands ARE the priority judgement, made once
 * here so the user doesn't have to make it every morning.
 */
export type Band =
  | "OVERDUE"
  | "REJECTED"
  | "DUE_TODAY"
  | "AWAITING_MY_REVIEW"
  | "BLOCKED"
  | "DUE_THIS_WEEK"
  | "LATER";

export const BAND_LABELS: Record<Band, string> = {
  OVERDUE: "Overdue",
  REJECTED: "Sent back to you",
  DUE_TODAY: "Due today",
  AWAITING_MY_REVIEW: "Waiting for your review",
  BLOCKED: "Blocked",
  DUE_THIS_WEEK: "Due this week",
  LATER: "Later",
};

/** Fixed display order. */
export const BAND_ORDER: Band[] = [
  "OVERDUE",
  "REJECTED",
  "DUE_TODAY",
  "AWAITING_MY_REVIEW",
  "BLOCKED",
  "DUE_THIS_WEEK",
  "LATER",
];

function bandFor(task: MyWorkTask, userId: bigint, now: Date, weekEnd: Date): Band {
  // Overdue outranks everything, including blocked: a blocked task that is
  // already late still needs someone to act today.
  if (task.dueDate < now) return "OVERDUE";

  // Work sent back is a commitment already broken once. It goes above
  // due-today because it is easy to forget — nobody is chasing it.
  if (task.reviewRound > 1 && task.status === TaskStatus.IN_PROGRESS && task.assigneeId === userId) {
    return "REJECTED";
  }

  if (task.dueDate.getTime() === now.getTime()) return "DUE_TODAY";

  // A review queue is the reviewer's own bottleneck, and the person waiting
  // cannot do anything about it. It belongs near the top of their day.
  if (task.status === TaskStatus.REVIEW && task.reviewerId === userId) {
    return "AWAITING_MY_REVIEW";
  }

  if (task.isBlocked) return "BLOCKED";
  if (task.dueDate <= weekEnd) return "DUE_THIS_WEEK";
  return "LATER";
}

export interface MyWorkSummary {
  bands: { band: Band; tasks: MyWorkTask[] }[];
  counts: {
    total: number;
    overdue: number;
    dueToday: number;
    blocked: number;
    awaitingMyReview: number;
    /** Open estimated minutes still to do. Excludes unestimated tasks. */
    remainingMinutes: number;
    /** How many tasks that figure could not count. Shown alongside it. */
    unestimated: number;
  };
}

export async function getMyWork(user: ActingUser): Promise<MyWorkSummary> {
  const tasks = await fetchMyOpenTasks(user);
  const now = today();
  const weekEnd = daysFromToday(7);

  const grouped = new Map<Band, MyWorkTask[]>();
  for (const band of BAND_ORDER) grouped.set(band, []);

  let remainingMinutes = 0;
  let unestimated = 0;

  for (const task of tasks) {
    grouped.get(bandFor(task, user.id, now, weekEnd))!.push(task);

    // ── Workload arithmetic: LEAF TASKS ONLY ────────────────────────────────
    //
    // Two exclusions, both of which cause double-counting if forgotten:
    //
    // 1. Only the ASSIGNEE carries the hours. A reviewer or contributor also
    //    sees the task, and counting it for them would inflate the firm's
    //    total by however many people are looking at it.
    //
    // 2. Only LEAF tasks count. A parent's estimate and its children's
    //    estimates both describe the same work — "GSTR-9: 4h" already covers
    //    "reconcile ITC: 2h". Summing both counted this work twice and
    //    reported 11h 30m where the real figure was 8h 30m.
    //
    //    The parent still appears in the list; its roll-up is shown on the
    //    row, but it is never added to capacity.
    if (task.assigneeId === user.id && !isParent(task)) {
      if (task.currentEstimateMinutes === null) unestimated += 1;
      else remainingMinutes += Math.max(0, task.currentEstimateMinutes - task.actualMinutes);
    }
  }

  return {
    bands: BAND_ORDER.map((band) => ({ band, tasks: grouped.get(band)! })).filter(
      (g) => g.tasks.length > 0
    ),
    counts: {
      total: tasks.length,
      overdue: grouped.get("OVERDUE")!.length,
      dueToday: grouped.get("DUE_TODAY")!.length,
      blocked: tasks.filter((t) => t.isBlocked).length,
      awaitingMyReview: tasks.filter(
        (t) => t.status === TaskStatus.REVIEW && t.reviewerId === user.id
      ).length,
      remainingMinutes,
      unestimated,
    },
  };
}

/** "3h 25m" — never "3.42 hours", which nobody can act on. */
export function formatMinutes(total: number): string {
  if (total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
