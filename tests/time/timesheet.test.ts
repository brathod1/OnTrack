/**
 * The weekly timesheet.
 *
 * Entries are inserted directly rather than through the service. The service's
 * backdating guard is deliberate and tested elsewhere; here it would only mean
 * these tests quietly stopped exercising past weeks once the fixture dates
 * aged past thirty days.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { ForbiddenError } from "@/lib/errors";
import { addDays, getTimesheet, startOfWeek } from "@/lib/time/timesheet";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

/** A Monday comfortably in the past, so "future day" logic is unambiguous. */
const WEEK = new Date("2026-08-17T00:00:00.000Z");
const day = (offset: number) => addDays(WEEK, offset);

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

async function entry(
  userId: bigint,
  taskId: bigint,
  workDate: Date,
  minutes: number,
  extra: { isSuspended?: boolean; editedById?: bigint } = {}
) {
  return prisma.timeEntry.create({
    data: {
      userId,
      taskId,
      workDate,
      durationMinutes: minutes,
      source: TimeEntrySource.MANUAL,
      // The database CHECK requires a note past eight hours, and it applies
      // whether or not the write came through the service. Going around the
      // service does not mean going around the invariants — which is the point
      // of putting them in the database rather than only in TypeScript.
      note: minutes > 8 * 60 ? "fixture: long entry" : null,
      isSuspended: extra.isSuspended ?? false,
      editedById: extra.editedById ?? null,
    },
  });
}

describe("startOfWeek", () => {
  it("finds Monday for a Monday-start organisation", () => {
    // 20 Aug 2026 is a Thursday.
    expect(startOfWeek(new Date("2026-08-20T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z"
    );
    // A Monday is its own week start, not the previous one.
    expect(startOfWeek(WEEK, 1).toISOString()).toBe("2026-08-17T00:00:00.000Z");
    // Sunday belongs to the week that started six days earlier.
    expect(startOfWeek(new Date("2026-08-23T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z"
    );
  });

  it("honours a Sunday-start organisation", () => {
    expect(startOfWeek(new Date("2026-08-20T00:00:00.000Z"), 0).toISOString()).toBe(
      "2026-08-16T00:00:00.000Z"
    );
  });
});

describe("the grid", () => {
  it("puts each entry on the right day and totals both ways", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 120);
    await entry(firm.users.eshan, firm.tasks.t1, day(2), 60);
    await entry(firm.users.eshan, firm.tasks.t6, day(0), 30);

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });

    expect(sheet.rows).toHaveLength(2);

    const t1 = sheet.rows.find((r) => r.taskId === firm.tasks.t1)!;
    expect(t1.cells[0]!.minutes).toBe(120);
    expect(t1.cells[1]!.minutes).toBe(0);
    expect(t1.cells[2]!.minutes).toBe(60);
    expect(t1.totalMinutes).toBe(180);

    // Monday: 120 + 30 across two tasks.
    expect(sheet.dailyTotals[0]).toBe(150);
    expect(sheet.dailyTotals[2]).toBe(60);
    expect(sheet.weekTotal).toBe(210);
  });

  it("ignores entries outside the week", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 60);
    await entry(firm.users.eshan, firm.tasks.t1, day(-1), 999);
    await entry(firm.users.eshan, firm.tasks.t1, day(7), 999);

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });
    expect(sheet.weekTotal).toBe(60);
  });

  it("accepts any date in the week and snaps to its start", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 60);

    // Asking for the Thursday must return the same sheet as asking for Monday.
    const sheet = await getTimesheet(actor.eshan!, { weekStart: day(3) });
    expect(sheet.weekStart.toISOString()).toBe(WEEK.toISOString());
    expect(sheet.weekTotal).toBe(60);
  });
});

describe("suspended entries", () => {
  it("are shown but count toward nothing", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 120);
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 600, { isSuspended: true });

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });

    // Ten unconfirmed hours must not appear in any total...
    expect(sheet.dailyTotals[0]).toBe(120);
    expect(sheet.weekTotal).toBe(120);

    // ...but must be visible, or the day silently reads short and the person
    // cannot see why.
    expect(sheet.suspendedCount).toBe(1);
    const t1 = sheet.rows.find((r) => r.taskId === firm.tasks.t1)!;
    expect(t1.cells[0]!.entries.some((e) => e.isSuspended)).toBe(true);
  });

  it("a day holding only a suspended entry is still flagged as empty", async () => {
    // Because nothing was actually recorded that day.
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 480, { isSuspended: true });

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });
    expect(sheet.dailyTotals[0]).toBe(0);
    expect(sheet.emptyWorkingDays.map((d) => d.toISOString())).toContain(
      day(0).toISOString()
    );
  });
});

describe("missing days", () => {
  it("flags working days with nothing on them", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 480);

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });

    // Fixture organisation works Mon–Sat, so Tue–Sat are missing and Sunday
    // is not. Flagging Sunday would train people to ignore the warning.
    expect(sheet.emptyWorkingDays).toHaveLength(5);
    expect(sheet.emptyWorkingDays.map((d) => d.toISOString())).not.toContain(
      day(6).toISOString()
    );
  });

  it("never flags a day that has not happened yet", async () => {
    const sheet = await getTimesheet(actor.eshan!, {});

    // The current week: days after today are empty but not missing.
    const future = sheet.days.filter((d) => d.getTime() > Date.now());
    for (const d of future) {
      expect(sheet.emptyWorkingDays.map((x) => x.toISOString())).not.toContain(
        d.toISOString()
      );
    }
  });
});

describe("whose sheet you may read", () => {
  it("your own, always", async () => {
    const sheet = await getTimesheet(actor.esha!, {});
    expect(sheet.isOwnSheet).toBe(true);
    expect(sheet.subject.id).toBe(firm.users.esha);
  });

  it("a manager may read someone who reports to them", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 60);

    const sheet = await getTimesheet(actor.meera!, {
      weekStart: WEEK,
      userId: firm.users.eshan,
    });
    expect(sheet.isOwnSheet).toBe(false);
    expect(sheet.weekTotal).toBe(60);
  });

  it("a peer may not", async () => {
    await expect(
      getTimesheet(actor.esha!, { userId: firm.users.eshan })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a manager may not read someone outside their report chain", async () => {
    // Nikhil manages Audit; Eshan reports to Meera. Holding the capability is
    // not the same as having standing over this particular person.
    await expect(
      getTimesheet(actor.nikhil!, { userId: firm.users.eshan })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("an intervention is never invisible", () => {
  it("marks an entry a manager changed", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 60, {
      editedById: firm.users.meera,
    });

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });
    const t1 = sheet.rows.find((r) => r.taskId === firm.tasks.t1)!;
    expect(t1.cells[0]!.entries[0]!.editedByOther).toBe(true);
  });

  it("does not mark an entry its owner edited", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, day(0), 60, {
      editedById: firm.users.eshan,
    });

    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });
    const t1 = sheet.rows.find((r) => r.taskId === firm.tasks.t1)!;
    expect(t1.cells[0]!.entries[0]!.editedByOther).toBe(false);
  });
});

describe("navigation", () => {
  it("refuses to go forward past the current week", async () => {
    const sheet = await getTimesheet(actor.eshan!, {});
    expect(sheet.canGoForward).toBe(false);
  });

  it("allows going forward from a past week", async () => {
    const sheet = await getTimesheet(actor.eshan!, { weekStart: WEEK });
    expect(sheet.canGoForward).toBe(true);
    expect(sheet.previousWeek.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(sheet.nextWeek.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });
});
