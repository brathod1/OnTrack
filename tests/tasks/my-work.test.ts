/**
 * The "My Work" screen's arithmetic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * These exist because of a bug that shipped to the first screenshot: a user's
 * remaining hours counted a parent task's estimate AND its subtasks',
 * reporting 11h 30m where the real figure was 8h 30m.
 *
 * It is a quiet failure. Nothing errors, nothing looks wrong — the number is
 * simply inflated, and a manager rebalancing work acts on it. The build spec
 * had called this out as "a real and common bug" before it was written anyway,
 * which is the best argument for pinning it here rather than trusting care.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Priority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { formatMinutes, getMyWork } from "@/lib/tasks/my-work";

let firm: Firm;
let eshan: ActingUser;
let keySeq = 0;

const h = (n: number) => n * 60;

function inDays(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function makeTask(opts: {
  title: string;
  assigneeId: bigint;
  dueOffset: number;
  estimate?: number | null;
  actual?: number;
  status?: TaskStatus;
  parentTaskId?: bigint;
  reviewerId?: bigint;
  isBlocked?: boolean;
  reviewRound?: number;
  /** Who asked for the work. Defaults to Meera, as most fixtures assume. */
  createdById?: bigint;
  contributorIds?: bigint[];
}) {
  keySeq += 1;
  const createdById = opts.createdById ?? firm.users.meera;
  return prisma.task.create({
    data: {
      displayKey: `TSK-MW-${String(keySeq).padStart(5, "0")}`,
      title: opts.title,
      engagementId: firm.engagements.a1,
      parentTaskId: opts.parentTaskId ?? null,
      createdById,
      assignedById: createdById,
      ...(opts.contributorIds?.length
        ? {
            contributors: {
              create: opts.contributorIds.map((userId) => ({
                userId,
                addedById: createdById,
              })),
            },
          }
        : {}),
      assigneeId: opts.assigneeId,
      reviewerId: opts.reviewerId ?? null,
      reviewRequired: Boolean(opts.reviewerId),
      status: opts.status ?? TaskStatus.ASSIGNED,
      priority: Priority.NORMAL,
      dueDate: inDays(opts.dueOffset),
      currentEstimateMinutes: opts.estimate === undefined ? h(2) : opts.estimate,
      originalEstimateMinutes: opts.estimate === undefined ? h(2) : opts.estimate,
      actualMinutes: opts.actual ?? 0,
      isBlocked: opts.isBlocked ?? false,
      blockedReason: opts.isBlocked ? "Waiting on the client" : null,
      // The database enforces cancel_needs_reason and blocked_needs_reason.
      // Fixtures have to satisfy them like anything else — a test helper that
      // could write a cancellation nobody explained would be creating data the
      // application can never produce.
      cancelReason:
        opts.status === TaskStatus.CANCELLED ? "Not required for this engagement" : null,
      cancelledAt: opts.status === TaskStatus.CANCELLED ? new Date() : null,
      completedAt: opts.status === TaskStatus.COMPLETED ? new Date() : null,
      reviewRound: opts.reviewRound ?? 1,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  eshan = await loadActingUser(firm.users.eshan);
  keySeq = 0;
  // The fixture firm ships tasks of its own; clear them so each assertion
  // starts from a known total rather than an inherited one.
  await prisma.task.deleteMany({});
});

describe("remaining hours count leaf tasks only", () => {
  it("does not add a parent's estimate on top of its subtasks'", async () => {
    const parent = await makeTask({
      title: "GST annual return",
      assigneeId: firm.users.eshan,
      dueOffset: 30,
      estimate: h(4),
      actual: h(1),
    });
    for (const t of ["Reconcile turnover", "Reconcile ITC", "Draft 9C"]) {
      await makeTask({
        title: t,
        assigneeId: firm.users.eshan,
        dueOffset: 20,
        estimate: h(2),
        parentTaskId: parent.id,
      });
    }

    const { counts } = await getMyWork(eshan);

    // 3 subtasks x 2h. The parent's own 3h remaining is NOT added: it
    // describes the same work the children describe.
    expect(counts.remainingMinutes).toBe(h(6));
    expect(formatMinutes(counts.remainingMinutes)).toBe("6h");
  });

  it("counts an ordinary task with no subtasks in full", async () => {
    await makeTask({
      title: "Standalone",
      assigneeId: firm.users.eshan,
      dueOffset: 5,
      estimate: h(4),
      actual: h(1),
    });

    const { counts } = await getMyWork(eshan);
    expect(counts.remainingMinutes).toBe(h(3));
  });

  it("never goes negative when actual has overrun the estimate", async () => {
    await makeTask({
      title: "Overrun",
      assigneeId: firm.users.eshan,
      dueOffset: 5,
      estimate: h(2),
      actual: h(9),
    });

    const { counts } = await getMyWork(eshan);
    // Being over the estimate does not mean there is negative work left.
    expect(counts.remainingMinutes).toBe(0);
  });

  it("excludes work where the user is only reviewer or contributor", async () => {
    // Otherwise the firm's total inflates by however many people are looking.
    const t = await makeTask({
      title: "Someone else's task",
      assigneeId: firm.users.esha,
      dueOffset: 5,
      estimate: h(8),
      reviewerId: firm.users.eshan,
    });
    await prisma.taskContributor.create({
      data: { taskId: t.id, userId: firm.users.eshan, addedById: firm.users.meera },
    });

    const { counts, bands } = await getMyWork(eshan);

    expect(counts.remainingMinutes).toBe(0);
    // It still APPEARS — he has to review it — it just carries no hours.
    expect(bands.flatMap((b) => b.tasks)).toHaveLength(1);
  });

  it("reports how many tasks it could not count", async () => {
    await makeTask({ title: "Estimated", assigneeId: firm.users.eshan, dueOffset: 5, estimate: h(3) });
    await makeTask({ title: "Not estimated", assigneeId: firm.users.eshan, dueOffset: 6, estimate: null });

    const { counts } = await getMyWork(eshan);

    expect(counts.remainingMinutes).toBe(h(3));
    // A confident number that silently omits work is how a manager stops
    // trusting the screen. The gap has to be visible next to the figure.
    expect(counts.unestimated).toBe(1);
  });
});

describe("banding puts the right thing first", () => {
  it("overdue outranks blocked — a late blocked task still needs action today", async () => {
    await makeTask({
      title: "Late and blocked",
      assigneeId: firm.users.eshan,
      dueOffset: -3,
      isBlocked: true,
      status: TaskStatus.IN_PROGRESS,
    });

    const { bands } = await getMyWork(eshan);
    expect(bands[0]?.band).toBe("OVERDUE");
  });

  it("work sent back appears above work merely due today", async () => {
    await makeTask({ title: "Due today", assigneeId: firm.users.eshan, dueOffset: 0 });
    await makeTask({
      title: "Sent back",
      assigneeId: firm.users.eshan,
      dueOffset: 4,
      status: TaskStatus.IN_PROGRESS,
      reviewRound: 2,
    });

    const { bands } = await getMyWork(eshan);
    const order = bands.map((b) => b.band);
    expect(order.indexOf("REJECTED")).toBeLessThan(order.indexOf("DUE_TODAY"));
  });

  it("a review queued for me is its own band, not buried in due-this-week", async () => {
    await makeTask({
      title: "Waiting on my review",
      assigneeId: firm.users.esha,
      reviewerId: firm.users.eshan,
      dueOffset: 3,
      status: TaskStatus.REVIEW,
    });

    const { bands, counts } = await getMyWork(eshan);
    expect(bands.map((b) => b.band)).toContain("AWAITING_MY_REVIEW");
    expect(counts.awaitingMyReview).toBe(1);
  });

  it("omits closed work entirely — this is a to-do list, not a history", async () => {
    await makeTask({
      title: "Done",
      assigneeId: firm.users.eshan,
      dueOffset: -5,
      status: TaskStatus.COMPLETED,
    });
    await makeTask({
      title: "Cancelled",
      assigneeId: firm.users.eshan,
      dueOffset: -5,
      status: TaskStatus.CANCELLED,
    });

    const { bands, counts } = await getMyWork(eshan);
    expect(counts.total).toBe(0);
    expect(bands).toHaveLength(0);
  });
});

describe("formatMinutes", () => {
  it("reads the way people say it", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(205)).toBe("3h 25m");
    // Never "3.42 hours" — nobody can act on a decimal hour.
    expect(formatMinutes(205)).not.toContain(".");
  });
});

/**
 * Work you asked somebody else to do.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GAP THESE PIN: you could create a task for a colleague and then have
 * nowhere to find it. My Work listed work where you are the assignee,
 * contributor or reviewer — and a requester is none of those. The kernel was
 * always willing to show the task (creator is a visibility relationship);
 * there was no screen that listed it, and a Staff user, having no Browse
 * screen, could not navigate to it at all.
 *
 * Harmless while delegating was something managers did on managers' screens.
 * Cross-department requesting makes it routine.
 *
 * The other half of these tests is what must NOT happen: delegated work is not
 * yours to do, so it must stay out of the priority bands and out of every
 * number describing your own load.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe("work you are waiting on someone else for", () => {
  it("appears, so a requester can find what they asked for", async () => {
    const task = await makeTask({
      title: "Excel pivot for the GST reconciliation",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      dueOffset: 5,
    });

    const work = await getMyWork(eshan);
    expect(work.requested.map((t) => t.displayKey)).toEqual([task.displayKey]);
  });

  it("stays OUT of the priority bands — it is not yours to do", async () => {
    await makeTask({
      title: "Excel pivot for the GST reconciliation",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      dueOffset: -3, // overdue: the band it would most loudly gatecrash
    });

    const work = await getMyWork(eshan);
    const banded = work.bands.flatMap((b) => b.tasks.map((t) => t.displayKey));
    expect(banded).toEqual([]);
    expect(work.requested).toHaveLength(1);
  });

  it("is counted in NOBODY's workload figures", async () => {
    // The whole point of the leaf-task rule is that one piece of work is
    // counted once. Adding delegated work to the requester's hours would
    // count it on two people's plates.
    await makeTask({
      title: "Excel pivot for the GST reconciliation",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      dueOffset: 5,
      estimate: h(6),
    });

    const work = await getMyWork(eshan);
    expect(work.counts.total).toBe(0);
    expect(work.counts.remainingMinutes).toBe(0);
    expect(work.counts.unestimated).toBe(0);
    expect(work.counts.overdue).toBe(0);
  });

  it("does not repeat work already on your own list", async () => {
    // Created it AND reviewing it: it is already in the bands as a review, and
    // listing it twice on one screen is how a screen stops being trusted.
    await makeTask({
      title: "Draft the computation",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      reviewerId: firm.users.eshan,
      status: TaskStatus.REVIEW,
      dueOffset: 4,
    });

    const work = await getMyWork(eshan);
    expect(work.requested).toEqual([]);
    expect(work.counts.awaitingMyReview).toBe(1);
  });

  it("does not repeat work you are contributing to", async () => {
    await makeTask({
      title: "Joint reconciliation",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      contributorIds: [firm.users.eshan],
      dueOffset: 4,
    });

    const work = await getMyWork(eshan);
    expect(work.requested).toEqual([]);
    expect(work.counts.total).toBe(1);
  });

  it("does not list work you kept for yourself", async () => {
    await makeTask({
      title: "My own task",
      createdById: firm.users.eshan,
      assigneeId: firm.users.eshan,
      dueOffset: 4,
    });

    const work = await getMyWork(eshan);
    expect(work.requested).toEqual([]);
    expect(work.counts.total).toBe(1);
  });

  it("drops off once the work is done — this is a waiting list, not a history", async () => {
    await makeTask({
      title: "Finished favour",
      createdById: firm.users.eshan,
      assigneeId: firm.users.ellie,
      dueOffset: 2,
      status: TaskStatus.COMPLETED,
    });

    expect((await getMyWork(eshan)).requested).toEqual([]);
  });

  it("shows you nobody else's delegations", async () => {
    // Meera asks Ellie for something. It is on neither of Eshan's lists,
    // whatever else he can see.
    await makeTask({
      title: "Meera's request",
      createdById: firm.users.meera,
      assigneeId: firm.users.ellie,
      dueOffset: 5,
    });

    const work = await getMyWork(eshan);
    expect(work.requested).toEqual([]);
    expect(work.bands).toEqual([]);
  });
});
