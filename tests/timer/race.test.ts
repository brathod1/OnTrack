/**
 * The timer race condition — automated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * This replaces the manual two-psql-window test, which proved unreliable to
 * coordinate: the window holding the transaction kept committing before the
 * second window attempted its insert, so we only ever re-tested the
 * sequential case.
 *
 * Here the attempts are genuinely simultaneous. Prisma's connection pool
 * holds several connections, so firing N creates at once with Promise.all
 * puts N inserts in flight across different backends. Exactly one may win.
 *
 * WHY THIS MATTERS: the application-level version of this check —
 *   "SELECT a running timer; if none, INSERT"
 * — passes for BOTH requests when they interleave, and creates two running
 * timers for one person. The user then logs two overlapping streams of hours
 * against different tasks, and every downstream number is wrong. A partial
 * unique index cannot be raced; a service-layer check can.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";

let firm: Firm;

const CONCURRENT_ATTEMPTS = 12;

beforeAll(async () => {
  await resetDatabase();
  firm = await buildFirm();
});

beforeEach(async () => {
  // Time entries only — leave the firm intact.
  await prisma.timeEntry.deleteMany({});
});

/** One attempt to start a timer. Resolves to whether it won or lost. */
function startTimer(userId: bigint, taskId: bigint) {
  return prisma.timeEntry
    .create({
      data: {
        taskId,
        userId,
        workDate: new Date("2026-08-26T00:00:00.000Z"),
        startedAt: new Date(),
        source: TimeEntrySource.TIMER,
      },
    })
    .then(() => "started" as const)
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      return { rejected: message } as const;
    });
}

describe("concurrent timer starts", () => {
  it(`allows exactly one of ${CONCURRENT_ATTEMPTS} simultaneous starts for the same user`, async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        startTimer(firm.users.eshan, firm.tasks.t1)
      )
    );

    const started = results.filter((r) => r === "started");
    const rejected = results.filter((r) => r !== "started");

    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENT_ATTEMPTS - 1);

    // And the database agrees — not just the return values.
    const running = await prisma.timeEntry.count({
      where: { userId: firm.users.eshan, endedAt: null, source: TimeEntrySource.TIMER },
    });
    expect(running).toBe(1);
  });

  it("rejects the losers for the right reason, not by accident", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => startTimer(firm.users.eshan, firm.tasks.t1))
    );

    const failures = results.filter(
      (r): r is { rejected: string } => typeof r === "object"
    );

    // Every loser must cite the timer index. A failure for any other reason —
    // a deadlock, a pool timeout, a foreign key — would mean this test passes
    // while proving nothing about the constraint.
    for (const f of failures) {
      expect(f.rejected).toMatch(/uniq_running_timer_per_user|Unique constraint/i);
    }
  });

  it("does not interfere across users — each may hold their own timer", async () => {
    const users = [firm.users.eshan, firm.users.esha, firm.users.ellie, firm.users.meera];

    const results = await Promise.all(users.map((u) => startTimer(u, firm.tasks.t1)));

    expect(results.every((r) => r === "started")).toBe(true);

    const running = await prisma.timeEntry.count({
      where: { endedAt: null, source: TimeEntrySource.TIMER },
    });
    expect(running).toBe(users.length);
  });

  it("frees the slot once the timer is stopped", async () => {
    expect(await startTimer(firm.users.eshan, firm.tasks.t1)).toBe("started");

    // A second start while running must fail...
    expect(await startTimer(firm.users.eshan, firm.tasks.t6)).not.toBe("started");

    await prisma.timeEntry.updateMany({
      where: { userId: firm.users.eshan, endedAt: null },
      data: { endedAt: new Date(), durationMinutes: 25 },
    });

    // ...and succeed once stopped, including on a different task.
    expect(await startTimer(firm.users.eshan, firm.tasks.t6)).toBe("started");
  });

  it("counts a suspended timer as still occupying the slot", async () => {
    // The watchdog SUSPENDS a forgotten timer rather than auto-logging it, and
    // a suspended entry still has endedAt = null. It must therefore still
    // block a new start — otherwise a user with a suspended timer could open a
    // second one and end up with two unresolved streams of hours.
    expect(await startTimer(firm.users.eshan, firm.tasks.t1)).toBe("started");

    await prisma.timeEntry.updateMany({
      where: { userId: firm.users.eshan, endedAt: null },
      data: { isSuspended: true },
    });

    expect(await startTimer(firm.users.eshan, firm.tasks.t6)).not.toBe("started");
  });

  it("ignores soft-deleted timers when deciding whether the slot is free", async () => {
    expect(await startTimer(firm.users.eshan, firm.tasks.t1)).toBe("started");

    await prisma.timeEntry.updateMany({
      where: { userId: firm.users.eshan, endedAt: null },
      data: { deletedAt: new Date(), deleteReason: "started by mistake" },
    });

    // The index excludes deleted rows, so the slot is free again.
    expect(await startTimer(firm.users.eshan, firm.tasks.t6)).toBe("started");
  });
});

describe("overlapping completed sessions", () => {
  const day = new Date("2026-08-26T00:00:00.000Z");
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 26, h, m));

  async function logSession(userId: bigint, from: Date, to: Date) {
    return prisma.timeEntry
      .create({
        data: {
          taskId: firm.tasks.t1,
          userId,
          workDate: day,
          startedAt: from,
          endedAt: to,
          durationMinutes: Math.round((to.getTime() - from.getTime()) / 60000),
          source: TimeEntrySource.TIMER,
        },
      })
      .then(() => "logged" as const)
      .catch(() => "rejected" as const);
  }

  it("rejects a session overlapping an existing one for the same user", async () => {
    expect(await logSession(firm.users.eshan, at(10), at(11))).toBe("logged");
    expect(await logSession(firm.users.eshan, at(10, 30), at(11, 30))).toBe("rejected");
  });

  it("allows an adjacent session — ranges are half-open", async () => {
    expect(await logSession(firm.users.eshan, at(10), at(11))).toBe("logged");
    expect(await logSession(firm.users.eshan, at(11), at(12))).toBe("logged");
  });

  it("allows two people to work the same hours", async () => {
    expect(await logSession(firm.users.eshan, at(10), at(11))).toBe("logged");
    expect(await logSession(firm.users.esha, at(10), at(11))).toBe("logged");
  });

  it("rejects a session that fully contains an existing one", async () => {
    expect(await logSession(firm.users.eshan, at(10), at(11))).toBe("logged");
    expect(await logSession(firm.users.eshan, at(9), at(12))).toBe("rejected");
  });
});
