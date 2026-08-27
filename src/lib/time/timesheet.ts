import { prisma } from "@/lib/db";
import { canEditOthersTime, type ActingUser } from "@/lib/auth/permissions";
import { ForbiddenError } from "@/lib/errors";
import { getCurrentOrganization } from "@/lib/org/current";
import { localWorkDate } from "./service";

/**
 * The weekly timesheet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A grid of tasks down the side and days across the top, because that is the
 * shape of the question people actually ask on a Friday afternoon: "what did I
 * do this week, and have I missed a day?"
 *
 * THE EMPTY DAYS ARE THE POINT. A list of entries hides the gaps; a grid makes
 * a blank Wednesday obvious. Since the firm's reason for tracking time is
 * knowing where effort went, an unnoticed missing day is the expensive failure
 * — not a slightly wrong number on a day someone did fill in.
 *
 * SUSPENDED ENTRIES ARE SHOWN BUT NOT COUNTED. Leaving them out entirely would
 * mean a day silently reading 6h when the person believes they worked 9h and
 * cannot see why. They appear in their own row, flagged, contributing zero to
 * every total until confirmed.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface TimesheetCell {
  entries: {
    id: bigint;
    minutes: number;
    note: string | null;
    isSuspended: boolean;
    source: string;
    editedByOther: boolean;
  }[];
  minutes: number;
}

export interface TimesheetRow {
  taskId: bigint;
  taskKey: string;
  taskTitle: string;
  clientName: string;
  engagementName: string;
  /** Seven cells, Monday-first or Sunday-first per the organisation. */
  cells: TimesheetCell[];
  totalMinutes: number;
}

export interface Timesheet {
  /** The person whose sheet this is — not necessarily the viewer. */
  subject: { id: bigint; name: string };
  isOwnSheet: boolean;
  /** Seven dates, in order. */
  days: Date[];
  rows: TimesheetRow[];
  dailyTotals: number[];
  weekTotal: number;
  /** Days with no time at all, excluding non-working days. */
  emptyWorkingDays: Date[];
  suspendedCount: number;
  weekStart: Date;
  previousWeek: Date;
  nextWeek: Date;
  /** Null when the next week is in the future — no forward-dating. */
  canGoForward: boolean;
}

/**
 * The start of the week containing `date`, per the organisation's setting.
 *
 * Works in UTC because work dates are stored as UTC-midnight calendar days.
 * Using local getDay() here would shift the whole grid by a day for anyone
 * west of Greenwich.
 */
export function startOfWeek(date: Date, weekStartsOn: number): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // getUTCDay: 0 = Sunday. weekStartsOn: 1 = Monday, matching ISO.
  const shift = (d.getUTCDay() - weekStartsOn + 7) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export async function getTimesheet(
  viewer: ActingUser,
  options: { weekStart?: Date; userId?: bigint } = {}
): Promise<Timesheet> {
  const org = await getCurrentOrganization();
  const subjectId = options.userId ?? viewer.id;
  const isOwnSheet = subjectId === viewer.id;

  // Someone else's timesheet is oversight, and the standing required to READ
  // it is the same as the standing required to CORRECT it. Reusing that check
  // rather than inventing a second one means the two can never drift apart
  // into "can fix what they cannot see".
  if (!isOwnSheet && !canEditOthersTime(viewer, subjectId)) {
    throw new ForbiddenError("view this person's timesheet");
  }

  const subject = await prisma.user.findUniqueOrThrow({
    where: { id: subjectId },
    select: { id: true, name: true },
  });

  const today = localWorkDate(new Date(), org.timezone);
  const weekStart = options.weekStart
    ? startOfWeek(options.weekStart, org.weekStartsOn)
    : startOfWeek(today, org.weekStartsOn);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = addDays(weekStart, 6);

  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: subjectId,
      deletedAt: null,
      workDate: { gte: weekStart, lte: weekEnd },
    },
    select: {
      id: true,
      taskId: true,
      workDate: true,
      durationMinutes: true,
      note: true,
      isSuspended: true,
      source: true,
      editedById: true,
      userId: true,
      task: {
        select: {
          id: true,
          displayKey: true,
          title: true,
          engagement: {
            select: { name: true, client: { select: { name: true } } },
          },
        },
      },
    },
    orderBy: [{ workDate: "asc" }, { id: "asc" }],
  });

  const byTask = new Map<string, TimesheetRow>();

  for (const e of entries) {
    const key = e.taskId.toString();

    if (!byTask.has(key)) {
      byTask.set(key, {
        taskId: e.taskId,
        taskKey: e.task.displayKey,
        taskTitle: e.task.title,
        clientName: e.task.engagement.client.name,
        engagementName: e.task.engagement.name,
        cells: Array.from({ length: 7 }, () => ({ entries: [], minutes: 0 })),
        totalMinutes: 0,
      });
    }

    const row = byTask.get(key)!;
    const dayIndex = Math.round(
      (e.workDate.getTime() - weekStart.getTime()) / 86_400_000
    );
    if (dayIndex < 0 || dayIndex > 6) continue;

    const cell = row.cells[dayIndex]!;
    cell.entries.push({
      id: e.id,
      minutes: e.durationMinutes,
      note: e.note,
      isSuspended: e.isSuspended,
      source: e.source,
      // Shown so an intervention on someone's timesheet is never invisible to
      // them, which is the difference between correction and alteration.
      editedByOther: e.editedById !== null && e.editedById !== e.userId,
    });

    // Suspended entries contribute NOTHING. They are visible so the person can
    // see why a day looks short, but they must never inflate a total.
    if (!e.isSuspended) {
      cell.minutes += e.durationMinutes;
      row.totalMinutes += e.durationMinutes;
    }
  }

  const rows = [...byTask.values()].sort(
    (a, b) =>
      a.clientName.localeCompare(b.clientName) || a.taskKey.localeCompare(b.taskKey)
  );

  const dailyTotals = days.map((_, i) =>
    rows.reduce((sum, r) => sum + r.cells[i]!.minutes, 0)
  );

  // A day is "empty" only if it is a working day, is not in the future, and
  // has nothing on it. Flagging future days or Sundays would train people to
  // ignore the warning, which is how a useful signal becomes wallpaper.
  const emptyWorkingDays = days.filter((d, i) => {
    const isoWeekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    return (
      org.workingDays.includes(isoWeekday) &&
      d.getTime() <= today.getTime() &&
      dailyTotals[i] === 0
    );
  });

  const suspendedCount = entries.filter((e) => e.isSuspended).length;
  const nextWeek = addDays(weekStart, 7);

  return {
    subject,
    isOwnSheet,
    days,
    rows,
    dailyTotals,
    weekTotal: dailyTotals.reduce((a, b) => a + b, 0),
    emptyWorkingDays,
    suspendedCount,
    weekStart,
    previousWeek: addDays(weekStart, -7),
    nextWeek,
    // Nothing to see in a week that has not happened.
    canGoForward: nextWeek.getTime() <= today.getTime(),
  };
}

/** People whose timesheets this user may open. Their own is always first. */
export async function getTimesheetSubjects(viewer: ActingUser) {
  const others = viewer.reportChainIds.length
    ? await prisma.user.findMany({
        where: { id: { in: viewer.reportChainIds }, status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  // Filtered through the same check the loader uses, so this list can never
  // offer a name that would then be refused.
  return others.filter((u) => canEditOthersTime(viewer, u.id));
}
