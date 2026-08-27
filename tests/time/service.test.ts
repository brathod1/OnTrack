/**
 * Time tracking rules.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Every assertion here protects the same thing: that the hours in this system
 * are worth believing.
 *
 * The failure mode is never a crash. It is a number quietly being wrong — 14
 * hours from a forgotten timer, a Friday entry dated Saturday, a total that
 * includes an unresolved timer. One of those in a report and people stop
 * trusting all of them, which costs more than the feature was worth.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { ForbiddenError, InvalidOperationError } from "@/lib/errors";
import {
  deleteTimeEntry,
  discardTimer,
  editTimeEntry,
  getRunningTimer,
  localWorkDate,
  logManualTime,
  startTimer,
  stopTimer,
} from "@/lib/time/service";
import { getSuspendedTimers, runTimerWatchdog } from "@/lib/time/watchdog";

let firm: Firm;
const actor: Record<string, ActingUser> = {};
let today: Date;

/**
 * A work date, relative to TODAY AS THE ORGANISATION SEES IT.
 *
 * Deriving this from UTC instead would make "refuses a future date" fail for
 * five and a half hours out of every day: after 18:30 UTC it is already
 * tomorrow in IST, so day(+1) is merely today and the service rightly permits
 * it. A test that only fails in the evening is worse than no test.
 */
const day = (offset = 0) => new Date(today.getTime() + offset * 86_400_000);

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }

  const org = await prisma.organization.findFirstOrThrow({ select: { timezone: true } });
  today = localWorkDate(new Date(), org.timezone);
});

describe("the running timer", () => {
  it("starts, and the server holds the start time", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);

    expect(started.startedAt).not.toBeNull();
    expect(started.endedAt).toBeNull();
    expect(started.source).toBe(TimeEntrySource.TIMER);
  });

  it("stops and records the elapsed minutes", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);

    // Backdate the start rather than waiting.
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 45 * 60_000) },
    });

    const stopped = await stopTimer(actor.eshan!);
    expect(stopped.durationMinutes).toBeGreaterThanOrEqual(44);
    expect(stopped.durationMinutes).toBeLessThanOrEqual(46);
  });

  it("starting a second timer stops the first, in one transaction", async () => {
    const first = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: first.started.id },
      data: { startedAt: new Date(Date.now() - 30 * 60_000) },
    });

    const second = await startTimer(actor.eshan!, firm.tasks.t6);

    // The swap is reported, so the UI can say what happened rather than
    // silently losing the first timer.
    expect(second.stopped?.minutes).toBeGreaterThanOrEqual(29);

    const running = await getRunningTimer(firm.users.eshan);
    expect(running?.taskId).toBe(firm.tasks.t6);

    const openCount = await prisma.timeEntry.count({
      where: { userId: firm.users.eshan, endedAt: null, deletedAt: null },
    });
    expect(openCount).toBe(1);
  });

  it("refuses to start a second timer on the SAME task", async () => {
    await startTimer(actor.eshan!, firm.tasks.t1);
    await expect(startTimer(actor.eshan!, firm.tasks.t1)).rejects.toBeInstanceOf(
      InvalidOperationError
    );
  });

  it("refuses a long timer stop without a note", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 9 * 3_600_000) },
    });

    await expect(stopTimer(actor.eshan!)).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(stopTimer(actor.eshan!, "Year-end stock count at client")).resolves.toBeDefined();
  });

  it("discarding frees the slot without recording time", async () => {
    await startTimer(actor.eshan!, firm.tasks.t1);
    await discardTimer(actor.eshan!, "wrong task");

    expect(await getRunningTimer(firm.users.eshan)).toBeNull();

    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(0);

    // Soft-deleted, so the mistake stays visible rather than vanishing.
    const entry = await prisma.timeEntry.findFirst({
      where: { taskId: firm.tasks.t1, userId: firm.users.eshan },
    });
    expect(entry?.deletedAt).not.toBeNull();
  });

  it("refuses to log time to a task the user has no part in", async () => {
    // Esha can SEE t5 through her engagement, but she is not the assignee,
    // a contributor or the reviewer. Logging hours against work she does not
    // own would make effort unattributable.
    await expect(startTimer(actor.esha!, firm.tasks.t5)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the task total is a cache of the ledger", () => {
  it("updates when time is logged", async () => {
    await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 90,
    });

    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(90);
  });

  it("updates when an entry is edited", async () => {
    const entry = await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 90,
    });
    await editTimeEntry(actor.eshan!, entry.id, { minutes: 30 });

    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(30);
  });

  it("updates when an entry is removed", async () => {
    const entry = await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 90,
    });
    await deleteTimeEntry(actor.eshan!, entry.id);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(0);
  });

  it("EXCLUDES suspended timers — an unresolved timer contributes nothing", async () => {
    await logManualTime(actor.eshan!, { taskId: firm.tasks.t1, workDate: day(0), minutes: 60 });

    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });
    await runTimerWatchdog();

    // Still 60. The 14 hours nobody worked are not in the total.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(60);
  });
});

describe("manual entry guardrails", () => {
  it("refuses a future date", async () => {
    await expect(
      logManualTime(actor.eshan!, { taskId: firm.tasks.t1, workDate: day(1), minutes: 60 })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("refuses more than 8 hours in one entry without a note", async () => {
    await expect(
      logManualTime(actor.eshan!, { taskId: firm.tasks.t1, workDate: day(0), minutes: 9 * 60 })
    ).rejects.toBeInstanceOf(InvalidOperationError);

    await expect(
      logManualTime(actor.eshan!, {
        taskId: firm.tasks.t1,
        workDate: day(0),
        minutes: 9 * 60,
        note: "Full day at client premises reconstructing ledgers",
      })
    ).resolves.toBeDefined();
  });

  it("refuses a day totalling more than 16 hours", async () => {
    await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 8 * 60,
    });
    await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t6,
      workDate: day(0),
      minutes: 7 * 60,
    });

    // A third entry would put the day past 16 hours — something is wrong with
    // the date, and a workload figure built on it would be nonsense.
    await expect(
      logManualTime(actor.eshan!, {
        taskId: firm.tasks.t1,
        workDate: day(0),
        minutes: 3 * 60,
        note: "long day",
      })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("stops a member backdating beyond the limit, but lets a manager record it", async () => {
    const old = day(-45);

    await expect(
      logManualTime(actor.eshan!, { taskId: firm.tasks.t1, workDate: old, minutes: 60 })
    ).rejects.toBeInstanceOf(InvalidOperationError);

    // Meera holds time.edit_others, so she can record historic time.
    await expect(
      logManualTime(actor.meera!, { taskId: firm.tasks.t2, workDate: old, minutes: 60 })
    ).resolves.toBeDefined();
  });

  it("refuses zero or negative time", async () => {
    await expect(
      logManualTime(actor.eshan!, { taskId: firm.tasks.t1, workDate: day(0), minutes: 0 })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe("editing someone else's time", () => {
  it("a manager may, with a reason", async () => {
    const entry = await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 120,
    });

    await expect(
      editTimeEntry(actor.meera!, entry.id, { minutes: 60 })
    ).rejects.toBeInstanceOf(InvalidOperationError);

    const fixed = await editTimeEntry(actor.meera!, entry.id, {
      minutes: 60,
      reason: "Duplicate of the entry on TSK-0002",
    });
    expect(fixed.durationMinutes).toBe(60);
    // Attributed, so an intervention is never anonymous.
    expect(fixed.editedAt).not.toBeNull();
  });

  it("a peer may not", async () => {
    const entry = await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 60,
    });
    await expect(
      editTimeEntry(actor.esha!, entry.id, { minutes: 30, reason: "meddling" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("editing your own entry is not marked as an intervention", async () => {
    const entry = await logManualTime(actor.eshan!, {
      taskId: firm.tasks.t1,
      workDate: day(0),
      minutes: 60,
    });
    const fixed = await editTimeEntry(actor.eshan!, entry.id, { minutes: 75 });

    expect(fixed.durationMinutes).toBe(75);
    expect(fixed.editedAt).toBeNull();
  });
});

describe("the forgotten-timer watchdog", () => {
  it("suspends a timer past the ceiling rather than logging it", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });

    const result = await runTimerWatchdog();

    expect(result.suspended).toHaveLength(1);
    expect(result.suspended[0]?.elapsedHours).toBeGreaterThan(13);

    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: started.id } });
    expect(entry.isSuspended).toBe(true);
    // Crucially: NOT closed with 14 hours. Nothing has been recorded.
    expect(entry.endedAt).toBeNull();
    expect(entry.durationMinutes).toBe(0);
  });

  it("leaves a timer inside the ceiling alone", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 3 * 3_600_000) },
    });

    const result = await runTimerWatchdog();
    expect(result.suspended).toHaveLength(0);
  });

  it("a suspended timer still occupies the slot", async () => {
    // Otherwise someone with an unresolved timer starts another and ends up
    // with two open streams of hours.
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });
    await runTimerWatchdog();

    const still = await getRunningTimer(firm.users.eshan);
    expect(still?.id).toBe(started.id);
  });

  it("surfaces suspended timers to their owner", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });
    await runTimerWatchdog();

    const waiting = await getSuspendedTimers(firm.users.eshan);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.task.displayKey).toBeDefined();
  });

  it("resolving a suspended timer records the confirmed time", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });
    await runTimerWatchdog();

    // The user says what they actually worked.
    await editTimeEntry(actor.eshan!, started.id, { minutes: 150 });

    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: started.id } });
    expect(entry.isSuspended).toBe(false);
    expect(entry.durationMinutes).toBe(150);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: firm.tasks.t1 } });
    expect(task.actualMinutes).toBe(150);
  });

  it("resolving CLOSES the timer and frees the slot", async () => {
    // The bug this pins: clearing isSuspended without setting endedAt leaves an
    // entry the watchdog will never revisit but getRunningTimer still reports —
    // a phantom timer the user cannot stop and which blocks starting a real one.
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });
    await runTimerWatchdog();

    await editTimeEntry(actor.eshan!, started.id, { minutes: 150 });

    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: started.id } });
    expect(entry.endedAt).not.toBeNull();
    // Derived from the confirmed duration, not from now() — he worked 2h30m,
    // he did not stop a timer that had run fourteen hours.
    expect(entry.endedAt!.getTime() - entry.startedAt!.getTime()).toBe(150 * 60_000);

    expect(await getRunningTimer(firm.users.eshan)).toBeNull();
    await expect(startTimer(actor.eshan!, firm.tasks.t6)).resolves.toBeDefined();
  });

  it("is idempotent — a second run does not re-suspend", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    await prisma.timeEntry.update({
      where: { id: started.id },
      data: { startedAt: new Date(Date.now() - 14 * 3_600_000) },
    });

    await runTimerWatchdog();
    const second = await runTimerWatchdog();
    expect(second.suspended).toHaveLength(0);
  });
});

describe("work date is a calendar day in the organisation's timezone", () => {
  it("dates a late-evening IST entry to that day, not the UTC one", async () => {
    // 21:30 IST on 26 August is 16:00 UTC on 26 August — fine. But 01:30 IST
    // on 27 August is 20:00 UTC on 26 August, and a server running in UTC
    // would date it a day early without this.
    const lateIst = new Date("2026-08-26T20:00:00.000Z"); // 01:30 IST, 27 Aug
    expect(localWorkDate(lateIst, "Asia/Kolkata").toISOString().slice(0, 10)).toBe("2026-08-27");
    expect(localWorkDate(lateIst, "UTC").toISOString().slice(0, 10)).toBe("2026-08-26");
  });

  it("stamps a started timer with the local date", async () => {
    const { started } = await startTimer(actor.eshan!, firm.tasks.t1);
    expect(started.workDate).toBeInstanceOf(Date);
    expect(started.workDate.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});
