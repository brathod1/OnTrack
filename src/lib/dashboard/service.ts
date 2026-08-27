import { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { visibleTaskFilter, type ActingUser } from "@/lib/auth/permissions";
import { getCurrentOrganization } from "@/lib/org/current";
import { localWorkDate } from "@/lib/time/service";

/**
 * The manager's view of everything they oversee.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY IS NOT: a page that ranks people. No completion
 * rates, no estimate accuracy, no cycle-time league table. That was a scope
 * decision and it is also the right one — score people on estimates and
 * everyone pads, and within a quarter the data underneath every other number
 * here is worthless.
 *
 * What is left is not a consolation prize. It is the three questions a
 * partner actually opens a system to ask:
 *
 *   WHAT IS AT RISK — what will embarrass us this month.
 *   WHERE IS THE LOAD — who is carrying too much, before something slips.
 *   WHAT IS EACH CLIENT ABSORBING — which eventually drives pricing.
 *
 * The load panel is about WORK, not about people. "Vikram has 34 hours
 * committed and three days left" is a staffing fact. "Vikram is slower than
 * Anjali" is a judgement this product does not make.
 *
 * EVERY FIGURE DECLARES WHAT IT COULD NOT COUNT. A confident number built on
 * missing estimates is how managers stop trusting the screen — and they only
 * stop once.
 *
 * SCOPE COMES FROM `visibleTaskFilter`, the same predicate the task list uses.
 * A partner sees their clients, not everyone's. There is no second definition
 * of "yours" here to drift from the first.
 * ─────────────────────────────────────────────────────────────────────────
 */

const OPEN: TaskStatus[] = [
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.REVIEW,
];

/** Blocked or in review longer than this is a stall, not a state. */
const STALL_DAYS = 3;

const dashboardSelect = {
  id: true,
  displayKey: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  dueDateType: true,
  externalDeadline: true,
  isBlocked: true,
  blockedReason: true,
  blockedSince: true,
  currentEstimateMinutes: true,
  actualMinutes: true,
  updatedAt: true,
  assigneeId: true,
  assignee: { select: { id: true, name: true } },
  parentTaskId: true,
  // Needed for the leaf-only rule. A parent's estimate and its children's
  // describe the same work; summing both double-counts it, which is a bug
  // this project has already shipped once and will not ship again.
  subtasks: { select: { id: true } },
  engagement: {
    select: {
      id: true,
      name: true,
      client: { select: { id: true, name: true, code: true } },
    },
  },
} satisfies Prisma.TaskSelect;

type DashboardTask = Prisma.TaskGetPayload<{ select: typeof dashboardSelect }>;

export interface RiskRow {
  id: string;
  key: string;
  title: string;
  clientName: string;
  assigneeName: string;
  dueDate: Date;
  /** Days late, or days stalled, depending on the bucket. */
  days: number;
  isStatutory: boolean;
}

export interface PersonLoad {
  userId: string;
  name: string;
  openTasks: number;
  overdue: number;
  /** Leaf tasks only, estimate minus actual, never negative. */
  remainingMinutes: number;
  /** How many of their open tasks carry no estimate at all. */
  unestimated: number;
}

export interface ClientEffort {
  clientId: string;
  name: string;
  code: string;
  openTasks: number;
  overdue: number;
  loggedMinutes: number;
  remainingMinutes: number;
  unestimated: number;
}

export interface Dashboard {
  overdue: RiskRow[];
  dueThisWeek: RiskRow[];
  /** Blocked for more than STALL_DAYS — a flag nobody has cleared. */
  stalledBlocked: RiskRow[];
  /** Sitting in review for more than STALL_DAYS — a queue nobody is serving. */
  stalledReview: RiskRow[];
  load: PersonLoad[];
  clients: ClientEffort[];
  totals: {
    openTasks: number;
    people: number;
    /** Open tasks with no estimate, across everything in scope. */
    unestimated: number;
  };
  stallDays: number;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function isLeaf(t: DashboardTask): boolean {
  return t.subtasks.length === 0;
}

function remainingOf(t: DashboardTask): number {
  if (!isLeaf(t) || t.currentEstimateMinutes === null) return 0;
  return Math.max(0, t.currentEstimateMinutes - t.actualMinutes);
}

function toRow(t: DashboardTask, days: number): RiskRow {
  return {
    id: t.id.toString(),
    key: t.displayKey,
    title: t.title,
    clientName: t.engagement.client.name,
    assigneeName: t.assignee.name,
    dueDate: t.dueDate,
    days,
    // A statutory deadline cannot be renegotiated with the client, which is
    // exactly what makes it different from an internal one.
    isStatutory: t.dueDateType === "EXTERNAL_FIXED",
  };
}

export async function getDashboard(user: ActingUser): Promise<Dashboard> {
  const org = await getCurrentOrganization();
  const today = localWorkDate(new Date(), org.timezone);
  const weekOut = new Date(today.getTime() + 7 * 86_400_000);
  const stallCutoff = new Date(Date.now() - STALL_DAYS * 86_400_000);

  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        { status: { in: OPEN }, deletedAt: null },
        // The same predicate the task list uses. One definition of "yours".
        visibleTaskFilter(user),
      ],
    },
    select: dashboardSelect,
  });

  // ── Risk ──────────────────────────────────────────────────────────────────

  const overdue: RiskRow[] = [];
  const dueThisWeek: RiskRow[] = [];
  const stalledBlocked: RiskRow[] = [];
  const stalledReview: RiskRow[] = [];

  for (const t of tasks) {
    if (t.dueDate < today) {
      overdue.push(toRow(t, daysBetween(t.dueDate, today)));
    } else if (t.dueDate <= weekOut) {
      dueThisWeek.push(toRow(t, daysBetween(today, t.dueDate)));
    }

    // Blocked and stalled-in-review are counted SEPARATELY from the date
    // buckets, not instead of them: a task can be both overdue and blocked,
    // and hiding it from one list because it appears in another is how the
    // most urgent item becomes the least visible.
    if (t.isBlocked && t.blockedSince && t.blockedSince < stallCutoff) {
      stalledBlocked.push(toRow(t, daysBetween(t.blockedSince, new Date())));
    }

    if (t.status === TaskStatus.REVIEW && t.updatedAt < stallCutoff) {
      // updatedAt is a proxy for "entered review" and will overstate freshness
      // if someone edits the task while it waits. Good enough to surface a
      // queue nobody is serving; not good enough to quote in a report.
      stalledReview.push(toRow(t, daysBetween(t.updatedAt, new Date())));
    }
  }

  const byDaysDesc = (a: RiskRow, b: RiskRow) => b.days - a.days;
  const byDaysAsc = (a: RiskRow, b: RiskRow) => a.days - b.days;

  overdue.sort(byDaysDesc);
  dueThisWeek.sort(byDaysAsc);
  stalledBlocked.sort(byDaysDesc);
  stalledReview.sort(byDaysDesc);

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadMap = new Map<string, PersonLoad>();

  for (const t of tasks) {
    const key = t.assigneeId.toString();

    if (!loadMap.has(key)) {
      loadMap.set(key, {
        userId: key,
        name: t.assignee.name,
        openTasks: 0,
        overdue: 0,
        remainingMinutes: 0,
        unestimated: 0,
      });
    }

    const row = loadMap.get(key)!;
    row.openTasks += 1;
    if (t.dueDate < today) row.overdue += 1;

    // Leaf-only, as above. A parent still counts as an open task — it is real
    // work someone is accountable for — but its hours are its children's.
    if (isLeaf(t)) {
      if (t.currentEstimateMinutes === null) row.unestimated += 1;
      else row.remainingMinutes += remainingOf(t);
    }
  }

  const load = [...loadMap.values()].sort(
    (a, b) => b.remainingMinutes - a.remainingMinutes || b.openTasks - a.openTasks
  );

  // ── Clients ───────────────────────────────────────────────────────────────

  const clientMap = new Map<string, ClientEffort>();

  for (const t of tasks) {
    const c = t.engagement.client;
    const key = c.id.toString();

    if (!clientMap.has(key)) {
      clientMap.set(key, {
        clientId: key,
        name: c.name,
        code: c.code,
        openTasks: 0,
        overdue: 0,
        loggedMinutes: 0,
        remainingMinutes: 0,
        unestimated: 0,
      });
    }

    const row = clientMap.get(key)!;
    row.openTasks += 1;
    if (t.dueDate < today) row.overdue += 1;

    // Hours logged come from the task's cached actual, which the time service
    // keeps in step with the ledger inside the same transaction. Suspended
    // timers are already excluded there, so nothing unconfirmed reaches this.
    row.loggedMinutes += t.actualMinutes;

    if (isLeaf(t)) {
      if (t.currentEstimateMinutes === null) row.unestimated += 1;
      else row.remainingMinutes += remainingOf(t);
    }
  }

  const clients = [...clientMap.values()].sort(
    (a, b) => b.remainingMinutes - a.remainingMinutes || b.openTasks - a.openTasks
  );

  return {
    overdue,
    dueThisWeek,
    stalledBlocked,
    stalledReview,
    load,
    clients,
    totals: {
      openTasks: tasks.length,
      people: loadMap.size,
      unestimated: tasks.filter((t) => isLeaf(t) && t.currentEstimateMinutes === null)
        .length,
    },
    stallDays: STALL_DAYS,
  };
}
