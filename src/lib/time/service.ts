import { ActivityAction, Prisma, TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordActivity } from "@/lib/activity/log";
import {
  can,
  canEditOthersTime,
  canLogTime,
  visibleTaskFilter,
  type ActingUser,
} from "@/lib/auth/permissions";
import { CAP } from "@/lib/auth/capabilities";
import { ForbiddenError, InvalidOperationError, NotFoundError } from "@/lib/errors";
import { getCurrentOrganization } from "@/lib/org/current";

/**
 * Time tracking.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SERVER OWNS THE CLOCK. A running timer stores `startedAt` server-side
 * and the browser only renders elapsed time. That is why a timer survives a
 * closed tab, a dead laptop, a crash and a second device — and why a client
 * cannot report "I worked six hours" by adjusting its own clock.
 *
 * TIME ENTRIES ARE THE LEDGER. `task.actualMinutes` is a cache written in the
 * same transaction. Nothing else may set it.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** More than this in one entry needs an explanation. Mirrors the DB CHECK. */
const NOTE_REQUIRED_ABOVE_MINUTES = 8 * 60;

/** Nobody works more than this in a day; beyond it, something is wrong. */
const MAX_MINUTES_PER_DAY = 16 * 60;

function backdateLimitDays(): number {
  const raw = Number(process.env.MANUAL_ENTRY_BACKDATE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export function watchdogHours(): number {
  const raw = Number(process.env.TIMER_WATCHDOG_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

/**
 * The calendar date an instant falls on, in the organisation's timezone.
 *
 * Returned as UTC midnight because that is how `work_date` is stored. Using
 * the server's timezone here would date a 9pm IST timer entry to the previous
 * day whenever the server runs in UTC — which it does in Azure.
 */
export function localWorkDate(instant: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return new Date(`${parts}T00:00:00.000Z`);
}

// ── Loading ─────────────────────────────────────────────────────────────────

const entrySelect = {
  id: true,
  taskId: true,
  userId: true,
  workDate: true,
  startedAt: true,
  endedAt: true,
  durationMinutes: true,
  source: true,
  note: true,
  isSuspended: true,
  editedAt: true,
  editReason: true,
  task: {
    select: {
      displayKey: true,
      title: true,
      engagement: { select: { name: true, client: { select: { code: true } } } },
    },
  },
} satisfies Prisma.TimeEntrySelect;

export type TimeEntryView = Prisma.TimeEntryGetPayload<{ select: typeof entrySelect }>;

/** The user's running timer, if any. At most one — the index guarantees it. */
export async function getRunningTimer(userId: bigint): Promise<TimeEntryView | null> {
  return prisma.timeEntry.findFirst({
    where: {
      userId,
      endedAt: null,
      source: TimeEntrySource.TIMER,
      deletedAt: null,
    },
    select: entrySelect,
  });
}

async function loadTaskForTimeLogging(user: ActingUser, taskId: bigint) {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, visibleTaskFilter(user)] },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      createdById: true,
      assignedById: true,
      reviewerId: true,
      engagementId: true,
      contributors: { select: { userId: true } },
      engagement: { select: { partnerId: true, managerId: true } },
    },
  });
  if (!task) throw new NotFoundError("Task");

  const permitted = canLogTime(user, {
    assigneeId: task.assigneeId,
    createdById: task.createdById,
    assignedById: task.assignedById,
    reviewerId: task.reviewerId,
    engagementId: task.engagementId,
    status: task.status,
    isContributor: task.contributors.some((c) => c.userId === user.id),
    engagementPartnerId: task.engagement.partnerId,
    engagementManagerId: task.engagement.managerId,
  });

  if (!permitted) {
    throw new ForbiddenError(
      "log time to this task — you are not the assignee, a contributor or the reviewer"
    );
  }

  return task;
}

/** Keep the cached total on the task in step with the ledger. */
async function refreshTaskActual(tx: Prisma.TransactionClient, taskId: bigint) {
  const sum = await tx.timeEntry.aggregate({
    where: { taskId, deletedAt: null, isSuspended: false },
    _sum: { durationMinutes: true },
  });
  await tx.task.update({
    where: { id: taskId },
    data: { actualMinutes: sum._sum.durationMinutes ?? 0 },
  });
}

// ── Timer ───────────────────────────────────────────────────────────────────

export interface StartTimerResult {
  started: TimeEntryView;
  /** Set when starting this one stopped another. The UI says so. */
  stopped?: { taskKey: string; taskTitle: string; minutes: number };
}

/**
 * Start a timer, stopping any other the user has running.
 *
 * The stop-and-start happens in ONE transaction. Done as two calls, a crash
 * between them leaves either two running timers — which the unique index
 * would then reject on every subsequent start — or none, silently losing the
 * elapsed time of the first.
 *
 * The caller is expected to have confirmed the swap; this does not ask.
 */
export async function startTimer(
  user: ActingUser,
  taskId: bigint
): Promise<StartTimerResult> {
  const task = await loadTaskForTimeLogging(user, taskId);
  const org = await getCurrentOrganization();
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    let stopped: StartTimerResult["stopped"];

    const running = await tx.timeEntry.findFirst({
      where: { userId: user.id, endedAt: null, source: TimeEntrySource.TIMER, deletedAt: null },
      select: {
        id: true, taskId: true, startedAt: true, isSuspended: true,
        task: { select: { displayKey: true, title: true } },
      },
    });

    if (running?.startedAt) {
      if (running.taskId === taskId) {
        throw new InvalidOperationError("A timer is already running on this task.");
      }

      // A SUSPENDED entry must never be auto-stopped.
      //
      // The stop-and-start below computes elapsed time from startedAt. For a
      // suspended timer that is the fourteen-hour figure the watchdog
      // deliberately refused to write — so without this guard, pressing
      // "Start timer" on any other task silently records it, defeating the
      // watchdog entirely through the most ordinary action in the product.
      //
      // Blocking the start is the lesser cost: it is one extra step, and the
      // person is the only one who knows the real number.
      if (running.isSuspended) {
        throw new InvalidOperationError(
          `Your timer on ${running.task.displayKey} was left running and is waiting to be confirmed. Say how long you worked on it before starting another.`
        );
      }

      const minutes = Math.max(
        0,
        Math.round((now.getTime() - running.startedAt.getTime()) / 60_000)
      );

      await tx.timeEntry.update({
        where: { id: running.id },
        data: { endedAt: now, durationMinutes: minutes },
      });
      await refreshTaskActual(tx, running.taskId);

      await recordActivity(tx, {
        taskId: running.taskId,
        actorId: user.id,
        action: ActivityAction.TIMER_STOPPED,
        newValue: { minutes },
        reason: "stopped automatically when another timer was started",
      });

      stopped = {
        taskKey: running.task.displayKey,
        taskTitle: running.task.title,
        minutes,
      };
    }

    const started = await tx.timeEntry.create({
      data: {
        taskId: task.id,
        userId: user.id,
        // The day the work is happening, in the organisation's timezone.
        workDate: localWorkDate(now, org.timezone),
        startedAt: now,
        source: TimeEntrySource.TIMER,
      },
      select: entrySelect,
    });

    await recordActivity(tx, {
      taskId: task.id,
      actorId: user.id,
      action: ActivityAction.TIMER_STARTED,
    });

    return { started, stopped };
  });
}

export interface StopTimerInput {
  note?: string;
  /**
   * The task the CALLER believes the timer is on.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * Stopping is not addressed to a task — it stops whatever the user has
   * running. That is correct, but it makes a stale page dangerous: leave task A
   * open in one tab, start a timer on task B in another, and tab A still shows
   * a live "Stop timer" button. Pressing it would stop B and record B's
   * minutes, while the page said it was stopping A.
   *
   * So the page states its belief and the server refuses when that belief is
   * out of date, exactly as `expectedVersion` does for task edits. Optional,
   * because a caller with no page behind it (a job, a script) has no belief to
   * state — but every UI path passes it.
   * ─────────────────────────────────────────────────────────────────────────
   */
  expectedTaskId?: bigint;
}

export async function stopTimer(user: ActingUser, input: StopTimerInput = {}) {
  const { note, expectedTaskId } = input;
  const running = await getRunningTimer(user.id);
  if (!running?.startedAt) {
    throw new InvalidOperationError("You have no timer running.");
  }

  if (expectedTaskId !== undefined && running.taskId !== expectedTaskId) {
    throw new InvalidOperationError(
      `Your timer has moved to ${running.task.displayKey} since this page was loaded. Reload it before stopping.`
    );
  }

  // Same reasoning as startTimer: stopping a suspended entry would compute the
  // elapsed figure the watchdog refused to write. The UI does not offer this,
  // but a service that trusts its UI is a service with a hole in it.
  if (running.isSuspended) {
    throw new InvalidOperationError(
      "That timer was left running and is waiting to be confirmed. Say how long you actually worked instead of stopping it."
    );
  }

  const now = new Date();
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - running.startedAt.getTime()) / 60_000)
  );

  // The database enforces this too; failing here gives a message a person can
  // act on rather than a constraint violation.
  if (minutes > NOTE_REQUIRED_ABOVE_MINUTES && !note?.trim()) {
    throw new InvalidOperationError(
      `That timer has run for over ${NOTE_REQUIRED_ABOVE_MINUTES / 60} hours. Add a note describing the work before stopping it.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const stopped = await tx.timeEntry.update({
      where: { id: running.id },
      data: { endedAt: now, durationMinutes: minutes, note: note?.trim() || null },
      select: entrySelect,
    });

    await refreshTaskActual(tx, running.taskId);

    await recordActivity(tx, {
      taskId: running.taskId,
      actorId: user.id,
      action: ActivityAction.TIMER_STOPPED,
      newValue: { minutes },
    });

    return stopped;
  });
}

/**
 * Abandon a running timer without recording any time.
 *
 * For the "started it on the wrong task" case. Soft-deleted with a reason
 * rather than removed, so the mistake is visible and the slot is freed —
 * the unique index ignores deleted rows.
 */
export async function discardTimer(
  user: ActingUser,
  reason = "started by mistake",
  /** Same stale-page guard as stopTimer — discarding the wrong task is worse. */
  expectedTaskId?: bigint
) {
  const running = await getRunningTimer(user.id);
  if (!running) throw new InvalidOperationError("You have no timer running.");

  if (expectedTaskId !== undefined && running.taskId !== expectedTaskId) {
    throw new InvalidOperationError(
      `Your timer has moved to ${running.task.displayKey} since this page was loaded. Reload it before discarding.`
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.timeEntry.update({
      where: { id: running.id },
      data: { deletedAt: new Date(), deleteReason: reason, endedAt: new Date() },
    });

    await recordActivity(tx, {
      taskId: running.taskId,
      actorId: user.id,
      action: ActivityAction.TIME_DELETED,
      reason,
    });
  });
}

// ── Manual entry ────────────────────────────────────────────────────────────

export interface ManualEntryInput {
  taskId: bigint;
  workDate: Date;
  minutes: number;
  note?: string;
}

/**
 * Manual entry, deliberately first-class.
 *
 * Purists want timer-only. In practice staff work in client offices, on calls
 * and on paper, and a timer-only system produces LESS accurate data — the day
 * gets reconstructed from memory anyway, just without a UI for it.
 */
export async function logManualTime(user: ActingUser, input: ManualEntryInput) {
  const task = await loadTaskForTimeLogging(user, input.taskId);
  const org = await getCurrentOrganization();

  if (input.minutes <= 0) {
    throw new InvalidOperationError("Enter how long you spent.");
  }

  const today = localWorkDate(new Date(), org.timezone);
  if (input.workDate > today) {
    throw new InvalidOperationError("You cannot log time against a future date.");
  }

  const daysBack = Math.round(
    (today.getTime() - input.workDate.getTime()) / 86_400_000
  );
  if (daysBack > backdateLimitDays() && !can(user, CAP.TIME_EDIT_OTHERS)) {
    // Someone reconstructing their own timesheet six weeks later should be
    // doing it with a manager. Asks for the CAPABILITY directly — an earlier
    // version called canEditOthersTime() with an arbitrary id as a proxy,
    // which returns false for managers too, since that function also checks
    // whether the id is in their report chain.
    throw new InvalidOperationError(
      `That date is more than ${backdateLimitDays()} days ago. Ask a manager to record it.`
    );
  }

  if (input.minutes > NOTE_REQUIRED_ABOVE_MINUTES && !input.note?.trim()) {
    throw new InvalidOperationError(
      `Entries over ${NOTE_REQUIRED_ABOVE_MINUTES / 60} hours need a note describing the work.`
    );
  }

  // A day is only so long. Beyond this something has been entered wrongly,
  // and a workload figure built on it would be nonsense.
  const existing = await prisma.timeEntry.aggregate({
    where: {
      userId: user.id,
      workDate: input.workDate,
      deletedAt: null,
      isSuspended: false,
    },
    _sum: { durationMinutes: true },
  });
  const dayTotal = (existing._sum.durationMinutes ?? 0) + input.minutes;
  if (dayTotal > MAX_MINUTES_PER_DAY) {
    throw new InvalidOperationError(
      `That would put ${Math.round(dayTotal / 60)} hours on one day. Check the date.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const entry = await tx.timeEntry.create({
      data: {
        taskId: task.id,
        userId: user.id,
        workDate: input.workDate,
        durationMinutes: input.minutes,
        source: TimeEntrySource.MANUAL,
        note: input.note?.trim() || null,
      },
      select: entrySelect,
    });

    await refreshTaskActual(tx, task.id);

    await recordActivity(tx, {
      taskId: task.id,
      actorId: user.id,
      action: ActivityAction.TIME_LOGGED,
      newValue: { minutes: input.minutes },
    });

    return entry;
  });
}

// ── Editing and removing ────────────────────────────────────────────────────

export async function editTimeEntry(
  user: ActingUser,
  entryId: bigint,
  input: { minutes: number; note?: string; reason?: string }
) {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true, taskId: true, userId: true, durationMinutes: true, deletedAt: true,
      startedAt: true, endedAt: true, isSuspended: true,
    },
  });
  if (!entry) throw new NotFoundError("Time entry");
  if (entry.deletedAt) throw new InvalidOperationError("That entry has been removed.");

  if (!canEditOthersTime(user, entry.userId)) {
    throw new ForbiddenError("edit someone else's time entry");
  }

  const isOthers = entry.userId !== user.id;
  if (isOthers && !input.reason?.trim()) {
    // Editing another person's timesheet is exactly the kind of change that
    // needs to be explainable months later.
    throw new InvalidOperationError("Give a reason for changing someone else's time entry.");
  }

  if (input.minutes < 0) throw new InvalidOperationError("Time cannot be negative.");
  if (input.minutes > NOTE_REQUIRED_ABOVE_MINUTES && !input.note?.trim()) {
    throw new InvalidOperationError(
      `Entries over ${NOTE_REQUIRED_ABOVE_MINUTES / 60} hours need a note.`
    );
  }

  // Resolving a suspended timer must CLOSE it, not just un-suspend it.
  //
  // A suspended entry still has endedAt = null, which is what keeps the
  // running-timer slot occupied. Clearing isSuspended without setting endedAt
  // leaves a timer that the watchdog will never look at again (it only reads
  // isSuspended: false rows past the ceiling, and this one's startedAt keeps
  // receding) but that getRunningTimer still reports as running — so the user
  // sees a phantom timer they cannot stop, and cannot start a real one.
  //
  // endedAt is derived from the confirmed duration rather than from now(),
  // because the person is telling us they worked 2h30m, not that they are
  // stopping a timer that ran fourteen hours.
  const closesTimer = entry.isSuspended && entry.endedAt === null && entry.startedAt !== null;
  const derivedEndedAt = closesTimer
    ? new Date(entry.startedAt!.getTime() + input.minutes * 60_000)
    : undefined;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.timeEntry.update({
      where: { id: entryId },
      data: {
        durationMinutes: input.minutes,
        note: input.note?.trim() || null,
        // Stamped only when someone else edits, so an author tidying their own
        // entry does not look like an intervention.
        ...(isOthers
          ? { editedById: user.id, editedAt: new Date(), editReason: input.reason }
          : {}),
        ...(derivedEndedAt ? { endedAt: derivedEndedAt } : {}),
        isSuspended: false,
      },
      select: entrySelect,
    });

    await refreshTaskActual(tx, entry.taskId);

    await recordActivity(tx, {
      taskId: entry.taskId,
      actorId: user.id,
      action: ActivityAction.TIME_EDITED,
      oldValue: { minutes: entry.durationMinutes },
      newValue: { minutes: input.minutes },
      reason: input.reason ?? null,
    });

    return updated;
  });
}

export async function deleteTimeEntry(user: ActingUser, entryId: bigint, reason?: string) {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
    select: { id: true, taskId: true, userId: true, durationMinutes: true, deletedAt: true },
  });
  if (!entry) throw new NotFoundError("Time entry");
  if (entry.deletedAt) return;

  if (!canEditOthersTime(user, entry.userId)) {
    throw new ForbiddenError("remove someone else's time entry");
  }
  if (entry.userId !== user.id && !reason?.trim()) {
    throw new InvalidOperationError("Give a reason for removing someone else's time entry.");
  }

  await prisma.$transaction(async (tx) => {
    // Soft, always. The application role has no DELETE on time_entries, and
    // hours someone worked should never silently disappear from the record.
    await tx.timeEntry.update({
      where: { id: entryId },
      data: { deletedAt: new Date(), deleteReason: reason ?? null },
    });

    await refreshTaskActual(tx, entry.taskId);

    await recordActivity(tx, {
      taskId: entry.taskId,
      actorId: user.id,
      action: ActivityAction.TIME_DELETED,
      oldValue: { minutes: entry.durationMinutes },
      reason: reason ?? null,
    });
  });
}
