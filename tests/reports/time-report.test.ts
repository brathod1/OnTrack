/**
 * The time report.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * This is the number that leaves the building. It goes into a billing
 * conversation, a fee negotiation, a partner's judgement about whether an
 * engagement is worth keeping. A wrong total here is not an inconvenience.
 *
 * The specific way it would go wrong is subtle: reading task.actualMinutes
 * instead of the ledger produces a report that sums correctly, looks entirely
 * plausible, and silently ignores the date range printed at the top of it.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TimeEntrySource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { getTimeReport } from "@/lib/reports/time-report";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const JAN = { from: day("2026-01-01"), to: day("2026-01-31") };

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
  workDate: string,
  minutes: number,
  extra: { isSuspended?: boolean; note?: string } = {}
) {
  return prisma.timeEntry.create({
    data: {
      userId,
      taskId,
      workDate: day(workDate),
      durationMinutes: minutes,
      source: TimeEntrySource.MANUAL,
      isSuspended: extra.isSuspended ?? false,
      note: extra.note ?? (minutes > 480 ? "fixture: long entry" : null),
    },
  });
}

describe("the date range is real", () => {
  it("counts only entries inside it", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-15", 120);
    await entry(firm.users.eshan, firm.tasks.t1, "2026-02-15", 999);
    await entry(firm.users.eshan, firm.tasks.t1, "2025-12-31", 999);

    const r = await getTimeReport(actor.admin!, JAN);

    expect(r.totalMinutes).toBe(120);
    expect(r.entryCount).toBe(1);
  });

  it("includes both endpoints", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-01", 60);
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-31", 60);

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.totalMinutes).toBe(120);
  });

  it("ignores the cached total on the task", async () => {
    // The failure this whole file exists to catch. task.actualMinutes is a
    // lifetime figure; a report bounded by dates that read it would sum
    // correctly and mean nothing.
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { actualMinutes: 99_999 },
    });
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-10", 45);

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.totalMinutes).toBe(45);
  });
});

describe("grouping", () => {
  it("rolls person into engagement into client, consistently", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);
    await entry(firm.users.meera, firm.tasks.t1, "2026-01-06", 60);
    await entry(firm.users.eshan, firm.tasks.t6, "2026-01-07", 30);

    const r = await getTimeReport(actor.admin!, JAN);
    const alpha = r.clients.find((c) => c.code === "ALPHA")!;

    expect(alpha.minutes).toBe(210);

    const engSum = alpha.engagements.reduce((n, e) => n + e.minutes, 0);
    expect(engSum).toBe(alpha.minutes);

    for (const eng of alpha.engagements) {
      const peopleSum = eng.people.reduce((n, p) => n + p.minutes, 0);
      expect(peopleSum).toBe(eng.minutes);
    }

    // And the firm-wide person totals agree with the grand total.
    expect(r.people.reduce((n, p) => n + p.minutes, 0)).toBe(r.totalMinutes);
  });

  it("keeps clients apart", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120); // Alpha
    await entry(firm.users.esha, firm.tasks.t4, "2026-01-05", 90); // Beta

    const r = await getTimeReport(actor.admin!, JAN);

    expect(r.clients.find((c) => c.code === "ALPHA")!.minutes).toBe(120);
    expect(r.clients.find((c) => c.code === "BETA")!.minutes).toBe(90);
    expect(r.totalMinutes).toBe(210);
  });

  it("orders by hours, heaviest first", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 60);
    await entry(firm.users.esha, firm.tasks.t4, "2026-01-05", 240);

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.clients[0]!.code).toBe("BETA");
  });
});

describe("suspended timers", () => {
  it("are excluded from every total, and reported separately", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-06", 600, {
      isSuspended: true,
    });

    const r = await getTimeReport(actor.admin!, JAN);

    // Ten unconfirmed hours must not reach a billing conversation.
    expect(r.totalMinutes).toBe(120);
    expect(r.entryCount).toBe(1);

    // But a partner must know why the month looks light.
    expect(r.suspendedCount).toBe(1);
    expect(r.suspendedMinutesIfConfirmed).toBe(600);
  });

  it("never appear as export lines", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-06", 600, {
      isSuspended: true,
    });

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.lines).toHaveLength(0);
  });
});

describe("deleted entries", () => {
  it("are gone from the report entirely", async () => {
    const e = await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);
    await prisma.timeEntry.update({
      where: { id: e.id },
      data: { deletedAt: new Date(), deleteReason: "logged against the wrong task" },
    });

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.totalMinutes).toBe(0);
    expect(r.lines).toHaveLength(0);
  });
});

describe("scope", () => {
  it("shows only hours on work the reader can see", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120); // EngA1
    await entry(firm.users.ellie, firm.tasks.t3, "2026-01-05", 300); // EngA2, audit

    // Meera manages EngA1 and EngB1, not the audit engagement.
    const r = await getTimeReport(actor.meera!, JAN);

    expect(r.totalMinutes).toBe(120);
    expect(r.lines.map((l) => l.taskKey)).not.toContain("TSK-TEST-0003");
  });

  it("shows nothing to someone related to nothing", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);

    const r = await getTimeReport(actor.chandra!, JAN);
    expect(r.totalMinutes).toBe(0);
    expect(r.clients).toHaveLength(0);
  });

  it("scopes by the TASK, not by whose entry it is", async () => {
    // Eshan's own hours on a task Meera oversees are hers to see. The entry
    // belongs to him; the visibility comes from the work.
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);

    const r = await getTimeReport(actor.meera!, JAN);
    expect(r.people.map((p) => p.name)).toContain("Eshan Exec");
  });
});

describe("filters", () => {
  it("narrows to one client", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120); // Alpha
    await entry(firm.users.esha, firm.tasks.t4, "2026-01-05", 90); // Beta

    const r = await getTimeReport(actor.admin!, { ...JAN, clientId: firm.clients.a });

    expect(r.totalMinutes).toBe(120);
    expect(r.clients).toHaveLength(1);
    expect(r.clients[0]!.code).toBe("ALPHA");
  });

  it("narrows to one person", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);
    await entry(firm.users.meera, firm.tasks.t1, "2026-01-05", 60);

    const r = await getTimeReport(actor.admin!, { ...JAN, userId: firm.users.meera });

    expect(r.totalMinutes).toBe(60);
    expect(r.people).toHaveLength(1);
  });
});

describe("export lines", () => {
  it("carry everything a spreadsheet needs, one row per entry", async () => {
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120, {
      note: "reconciled the ITC ledger",
    });

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.lines).toHaveLength(1);

    const line = r.lines[0]!;
    expect(line.clientName).toBe("Alpha Industries");
    expect(line.clientCode).toBe("ALPHA");
    expect(line.engagementName).toBe("Tax Compliance");
    expect(line.taskKey).toBe("TSK-TEST-0001");
    expect(line.personName).toBe("Eshan Exec");
    expect(line.minutes).toBe(120);
    expect(line.note).toBe("reconciled the ITC ledger");
  });

  it("sum to the same total as the grouped view", async () => {
    // A spreadsheet that disagrees with the screen it came from is worse than
    // no spreadsheet — one of them is wrong and nobody knows which.
    await entry(firm.users.eshan, firm.tasks.t1, "2026-01-05", 120);
    await entry(firm.users.meera, firm.tasks.t2, "2026-01-06", 45);
    await entry(firm.users.esha, firm.tasks.t4, "2026-01-07", 90);

    const r = await getTimeReport(actor.admin!, JAN);
    expect(r.lines.reduce((n, l) => n + l.minutes, 0)).toBe(r.totalMinutes);
  });
});
