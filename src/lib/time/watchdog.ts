import { ActivityAction, TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordActivity } from "@/lib/activity/log";
import { watchdogHours } from "./service";

/**
 * The forgotten-timer watchdog.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * People forget to stop timers. Reliably, weekly, forever. Without this,
 * "Actual: 3h 20m" becomes "Actual: 14h 02m" and the estimate-vs-actual
 * reporting the firm asked for is worthless.
 *
 * IT SUSPENDS. IT DOES NOT GUESS.
 *
 * The tempting alternatives are both wrong:
 *
 *   Auto-log the full elapsed time — writes 14 hours nobody worked. One such
 *   entry in a report and people stop believing every number in the system.
 *
 *   Auto-log some assumed default, say 8 hours — invents data with no basis,
 *   and worse, looks plausible enough that nobody questions it.
 *
 * So a suspended entry keeps its start time, counts toward nothing, and waits
 * for its owner to say how long they actually worked. Suspended entries are
 * excluded from every total (see refreshTaskActual), so the number stays
 * honest while it is unresolved.
 *
 * The timer slot stays OCCUPIED while suspended — `endedAt` is still null, so
 * the unique index still applies. Someone with an unresolved timer cannot
 * start another and end up with two open streams of hours.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface WatchdogResult {
  suspended: {
    entryId: bigint;
    userId: bigint;
    userName: string;
    taskKey: string;
    startedAt: Date;
    elapsedHours: number;
  }[];
  ceilingHours: number;
}

export async function runTimerWatchdog(now = new Date()): Promise<WatchdogResult> {
  const ceilingHours = watchdogHours();
  const cutoff = new Date(now.getTime() - ceilingHours * 3_600_000);

  const stale = await prisma.timeEntry.findMany({
    where: {
      source: TimeEntrySource.TIMER,
      endedAt: null,
      deletedAt: null,
      isSuspended: false,
      startedAt: { lt: cutoff },
    },
    select: {
      id: true,
      userId: true,
      taskId: true,
      startedAt: true,
      user: { select: { name: true } },
      task: { select: { displayKey: true } },
    },
  });

  const suspended: WatchdogResult["suspended"] = [];

  for (const entry of stale) {
    if (!entry.startedAt) continue;
    const elapsedHours = (now.getTime() - entry.startedAt.getTime()) / 3_600_000;

    await prisma.$transaction(async (tx) => {
      await tx.timeEntry.update({
        where: { id: entry.id },
        data: { isSuspended: true },
      });

      await recordActivity(tx, {
        taskId: entry.taskId,
        // Attributed to the person whose timer it is, not a system account:
        // they are the one who has to resolve it, and the entry is theirs.
        actorId: entry.userId,
        action: ActivityAction.TIMER_SUSPENDED,
        newValue: { elapsedHours: Math.round(elapsedHours * 10) / 10 },
        reason: `Timer ran past ${ceilingHours} hours without being stopped. No time has been recorded until it is confirmed.`,
      });
    });

    suspended.push({
      entryId: entry.id,
      userId: entry.userId,
      userName: entry.user.name,
      taskKey: entry.task.displayKey,
      startedAt: entry.startedAt,
      elapsedHours: Math.round(elapsedHours * 10) / 10,
    });
  }

  return { suspended, ceilingHours };
}

/** Entries awaiting confirmation from this user. Shown on their next visit. */
export async function getSuspendedTimers(userId: bigint) {
  return prisma.timeEntry.findMany({
    where: { userId, isSuspended: true, deletedAt: null },
    select: {
      id: true,
      startedAt: true,
      workDate: true,
      task: { select: { displayKey: true, title: true } },
    },
    orderBy: { startedAt: "asc" },
  });
}
