/**
 * The team dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Aggregates are where a system lies most convincingly. A wrong total looks
 * exactly like a right one, nobody can check it by eye, and by the time
 * somebody notices, decisions have been made on it.
 *
 * Two of these tests defend rules that have ALREADY been got wrong once in
 * this project: counting a parent's estimate on top of its children's, and
 * letting a scope leak past `visibleTaskFilter`.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { getDashboard } from "@/lib/dashboard/service";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

async function setDue(taskId: bigint, days: number) {
  await prisma.task.update({
    where: { id: taskId },
    data: { dueDate: daysFromNow(days) },
  });
}

describe("scope", () => {
  it("shows an admin everything, and Chandra nothing", async () => {
    const adminView = await getDashboard(actor.admin!);
    expect(adminView.totals.openTasks).toBeGreaterThan(0);

    // Chandra is active and valid but related to nothing. A dashboard that
    // leaked here would leak everywhere, since it is the widest query in the
    // product.
    const chandraView = await getDashboard(actor.chandra!);
    expect(chandraView.totals.openTasks).toBe(0);
    expect(chandraView.load).toHaveLength(0);
    expect(chandraView.clients).toHaveLength(0);
  });

  it("scopes a manager to the work they actually oversee", async () => {
    const meera = await getDashboard(actor.meera!);

    // Meera manages EngA1 and EngB1. EngA2 is Nikhil's audit engagement and
    // must not appear.
    const clientCodes = meera.clients.map((c) => c.code);
    expect(clientCodes).toContain("ALPHA");

    const keys = [
      ...meera.overdue,
      ...meera.dueThisWeek,
      ...meera.stalledBlocked,
      ...meera.stalledReview,
    ].map((r) => r.key);
    expect(keys).not.toContain("TSK-TEST-0003"); // EngA2, Nikhil's
  });
});

describe("what is at risk", () => {
  it("separates overdue from due-this-week, with days on each", async () => {
    await setDue(firm.tasks.t1, -5);
    await setDue(firm.tasks.t2, 3);
    await setDue(firm.tasks.t6, 40);

    const d = await getDashboard(actor.admin!);

    const overdueKeys = d.overdue.map((r) => r.key);
    expect(overdueKeys).toContain("TSK-TEST-0001");

    const soonKeys = d.dueThisWeek.map((r) => r.key);
    expect(soonKeys).toContain("TSK-TEST-0002");
    // Forty days out is neither overdue nor this week.
    expect([...overdueKeys, ...soonKeys]).not.toContain("TSK-TEST-0006");

    expect(d.overdue.find((r) => r.key === "TSK-TEST-0001")!.days).toBe(5);
  });

  it("puts the latest first, because that is the one to ask about", async () => {
    await setDue(firm.tasks.t1, -2);
    await setDue(firm.tasks.t2, -9);

    const d = await getDashboard(actor.admin!);
    expect(d.overdue[0]!.key).toBe("TSK-TEST-0002");
  });

  it("counts a blocked task in BOTH the overdue and the stalled lists", async () => {
    // Appearing in one list must not remove it from another. A task that is
    // overdue AND blocked is the most urgent thing on the page, and hiding it
    // from the overdue list would make it the least visible.
    await setDue(firm.tasks.t1, -4);
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: {
        isBlocked: true,
        blockedReason: "awaiting bank statements",
        blockedSince: daysFromNow(-6),
      },
    });

    const d = await getDashboard(actor.admin!);
    expect(d.overdue.map((r) => r.key)).toContain("TSK-TEST-0001");
    expect(d.stalledBlocked.map((r) => r.key)).toContain("TSK-TEST-0001");
  });

  it("ignores a block that is only a day old", async () => {
    // Blocked is normal. Blocked for a week is a stall.
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: {
        isBlocked: true,
        blockedReason: "waiting on the client",
        blockedSince: daysFromNow(-1),
      },
    });

    const d = await getDashboard(actor.admin!);
    expect(d.stalledBlocked.map((r) => r.key)).not.toContain("TSK-TEST-0001");
  });

  it("surfaces a review queue nobody is serving", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t4 },
      data: { status: TaskStatus.REVIEW },
    });
    // Backdate the row so it looks like it has been sitting there.
    await prisma.$executeRaw`
      UPDATE tasks SET updated_at = now() - interval '9 days' WHERE id = ${firm.tasks.t4}
    `;

    const d = await getDashboard(actor.admin!);
    const stalled = d.stalledReview.find((r) => r.key === "TSK-TEST-0004");
    expect(stalled).toBeDefined();
    expect(stalled!.days).toBeGreaterThanOrEqual(8);
  });

  it("marks statutory deadlines apart from internal ones", async () => {
    await setDue(firm.tasks.t1, -1);
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { dueDateType: "EXTERNAL_FIXED" },
    });

    const d = await getDashboard(actor.admin!);
    // A date that cannot be renegotiated with the client is a different kind
    // of late from one that can.
    expect(d.overdue.find((r) => r.key === "TSK-TEST-0001")!.isStatutory).toBe(true);
  });

  it("omits closed work entirely", async () => {
    await setDue(firm.tasks.t1, -5);
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { status: TaskStatus.COMPLETED },
    });

    const d = await getDashboard(actor.admin!);
    expect(d.overdue.map((r) => r.key)).not.toContain("TSK-TEST-0001");
  });
});

describe("where the load is", () => {
  it("counts leaf tasks only — never a parent on top of its children", async () => {
    // The bug this project already shipped once. A parent's estimate and its
    // children's describe the same work.
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { currentEstimateMinutes: 180 },
    });
    await prisma.task.create({
      data: {
        displayKey: "TSK-TEST-0101",
        title: "Child of t1",
        engagementId: firm.engagements.a1,
        createdById: firm.users.meera,
        assignedById: firm.users.meera,
        assigneeId: firm.users.eshan,
        parentTaskId: firm.tasks.t1,
        dueDate: daysFromNow(10),
        currentEstimateMinutes: 60,
      },
    });

    const d = await getDashboard(actor.admin!);
    const eshan = d.load.find((p) => p.userId === firm.users.eshan.toString())!;

    // t6 (120) + the child (60) = 180. The parent's own 180 is NOT added.
    expect(eshan.remainingMinutes).toBe(180);
    // But the parent is still an open task he is accountable for.
    expect(eshan.openTasks).toBe(3);
  });

  it("subtracts time already logged", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { currentEstimateMinutes: 120, actualMinutes: 90 },
    });

    const d = await getDashboard(actor.admin!);
    const eshan = d.load.find((p) => p.userId === firm.users.eshan.toString())!;
    // 30 remaining on t1, plus 120 on t6.
    expect(eshan.remainingMinutes).toBe(150);
  });

  it("never goes negative when the work has overrun", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { currentEstimateMinutes: 60, actualMinutes: 600 },
    });

    const d = await getDashboard(actor.admin!);
    const eshan = d.load.find((p) => p.userId === firm.users.eshan.toString())!;
    // A negative remainder would silently reduce someone ELSE's apparent load
    // when the figures are read together.
    expect(eshan.remainingMinutes).toBe(120);
  });

  it("reports what it could not count", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { currentEstimateMinutes: null },
    });

    const d = await getDashboard(actor.admin!);
    const eshan = d.load.find((p) => p.userId === firm.users.eshan.toString())!;

    // A confident number built on missing data is how managers stop trusting
    // the screen, and they only stop once.
    expect(eshan.unestimated).toBe(1);
    expect(d.totals.unestimated).toBeGreaterThanOrEqual(1);
  });

  it("counts overdue per person", async () => {
    await setDue(firm.tasks.t1, -3);

    const d = await getDashboard(actor.admin!);
    const eshan = d.load.find((p) => p.userId === firm.users.eshan.toString())!;
    expect(eshan.overdue).toBe(1);
  });

  it("orders by remaining hours, heaviest first", async () => {
    const d = await getDashboard(actor.admin!);
    for (let i = 1; i < d.load.length; i++) {
      expect(d.load[i - 1]!.remainingMinutes).toBeGreaterThanOrEqual(
        d.load[i]!.remainingMinutes
      );
    }
  });
});

describe("what each client is absorbing", () => {
  it("sums hours logged and work remaining per client", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { actualMinutes: 300, currentEstimateMinutes: 480 },
    });

    const d = await getDashboard(actor.admin!);
    const alpha = d.clients.find((c) => c.code === "ALPHA")!;

    expect(alpha.loggedMinutes).toBeGreaterThanOrEqual(300);
    expect(alpha.remainingMinutes).toBeGreaterThanOrEqual(180);
    expect(alpha.openTasks).toBeGreaterThan(0);
  });

  it("keeps clients separate", async () => {
    const d = await getDashboard(actor.admin!);
    const codes = d.clients.map((c) => c.code);

    expect(codes).toContain("ALPHA");
    expect(codes).toContain("BETA");
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("counts a client's overdue work", async () => {
    await setDue(firm.tasks.t1, -2);

    const d = await getDashboard(actor.admin!);
    expect(d.clients.find((c) => c.code === "ALPHA")!.overdue).toBe(1);
  });
});

/**
 * "Asked by" on a risk row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A row named only the assignee, so cross-department work looked exactly like
 * work someone had picked up themselves. A manager glancing at the dashboard
 * could not tell that one of their people had pulled a colleague in from
 * another team — the fact was in the database and on the task page, and
 * nowhere they would actually look.
 *
 * DISCLOSES NOTHING NEW. Every row here is already visible through
 * `visibleTaskFilter`, and the creator's name is already on the task page.
 * This saves a click; it does not widen scope, which is why these tests assert
 * on the LABEL and the scope tests above still own the question of what
 * appears at all.
 *
 * The suppression rules carry as much weight as the label. A name on every row
 * would bury the one row that matters.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe("who asked for the work", () => {
  /** Fixture t1: EngA1, created by Meera, assigned to Eshan, due far out. */
  const t1Row = (d: Awaited<ReturnType<typeof getDashboard>>) =>
    [...d.overdue, ...d.dueThisWeek].find((r) => r.key === "TSK-TEST-0001");

  it("names the requester when somebody else asked", async () => {
    await setDue(firm.tasks.t1, 2);

    // Priya is the engagement partner: she sees the work, and she did not
    // create it. This is the case the field exists for.
    const row = t1Row(await getDashboard(actor.priya!));
    expect(row?.assigneeName).toBe("Eshan Exec");
    expect(row?.requestedByName).toBe("Meera Manager");
  });

  it("says nothing when you are the one who asked", async () => {
    await setDue(firm.tasks.t1, 2);

    // Meera created it. Repeating her own name on every row she delegated is
    // how the one row somebody else asked for stops standing out.
    const row = t1Row(await getDashboard(actor.meera!));
    expect(row?.requestedByName).toBeNull();
  });

  it("says nothing when the assignee created their own task", async () => {
    // Nobody asked them. "Asked by Meera Manager" on Meera's own task would
    // be true and useless.
    await setDue(firm.tasks.t2, 2); // EngA1, created by Meera, assigned to Meera

    const row = [...(await getDashboard(actor.priya!)).dueThisWeek].find(
      (r) => r.key === "TSK-TEST-0002"
    );
    expect(row?.assigneeName).toBe("Meera Manager");
    expect(row?.requestedByName).toBeNull();
  });

  it("carries the label on overdue rows too, not only this week's", async () => {
    await setDue(firm.tasks.t1, -4);

    const d = await getDashboard(actor.priya!);
    expect(d.overdue.find((r) => r.key === "TSK-TEST-0001")?.requestedByName).toBe(
      "Meera Manager"
    );
  });
});
