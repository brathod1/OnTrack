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
  // Both added for the "Waiting on someone else" list: `createdById` is how a
  // row works out that you are the REQUESTER rather than a contributor, and
  // the contributor ids are how that list avoids repeating work already shown
  // above it.
  createdById: true,
  updatedAt: true,
  assignee: { select: { id: true, name: true } },
  contributors: { select: { userId: true } },
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
 * Work you asked someone else to do.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: you could create a task for a colleague and then have
 * nowhere to find it again. My Work lists what is on YOUR plate — assignee,
 * contributor, reviewer — and a requester is none of those. The permission
 * kernel was always happy to show them the task (creator is one of the
 * visibility relationships); there was simply no screen that listed it, and
 * for a Staff user, who has no Browse screen, no way to navigate to it at all.
 *
 * Harmless while delegation was something managers did on screens built for
 * managers. Cross-department requesting makes it the common case: you ask a
 * colleague in another team for a spreadsheet and then cannot see whether it
 * has been done.
 *
 * ── This grants nothing ──────────────────────────────────────────────────
 * Every task here is one the caller could already open by URL. Like
 * `fetchMyOpenTasks`, the predicate is a relationship to the CALLER — tasks
 * they created — so it cannot return anyone else's work however the caller's
 * role is configured. That is what makes it safe to skip `visibleTaskFilter`
 * here, exactly as the function above skips it.
 *
 * ── Deliberately NOT counted in the workload figures ─────────────────────
 * The hours and counts at the top of the screen are what YOU have to do.
 * Adding work you delegated would count the same task on two people's plates
 * and inflate the very number the leaf-task rule exists to keep honest.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function fetchDelegatedTasks(user: ActingUser) {
  const created = await prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { in: [...OPEN_STATUSES] },
      createdById: user.id,
    },
    select: listSelect,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });

  // Filtered here rather than in the query. Excluding "tasks where I am the
  // assignee OR reviewer OR a contributor" in SQL means negating a comparison
  // against a NULLABLE column, and `NOT (reviewer_id = 42)` is NULL — not
  // true — for every task with no reviewer, which would silently drop them.
  // The set is small (open tasks you created), so filtering in code is both
  // cheaper to reason about and obviously correct.
  return created.filter(
    (t) =>
      t.assigneeId !== user.id &&
      t.reviewerId !== user.id &&
      !t.contributors.some((c) => c.userId === user.id)
  );
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
  /**
   * Open work you created that is now somebody else's to do.
   *
   * Kept out of `bands` on purpose. The bands are a priority order for what
   * YOU should act on this morning; work you are waiting on belongs beside
   * that list, not inside it. It is also absent from every figure in `counts`.
   */
  requested: MyWorkTask[];
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
  const [tasks, requested] = await Promise.all([
    fetchMyOpenTasks(user),
    fetchDelegatedTasks(user),
  ]);
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
    requested,
    counts: {
      // `tasks`, not `tasks + requested`. "8 open tasks" has to mean eight
      // things you have to do; counting work you handed to someone else makes
      // the headline figure describe nobody's day.
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
