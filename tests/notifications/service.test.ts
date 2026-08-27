/**
 * Notifications.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Two properties are worth more than the rest put together, and most of this
 * file defends them:
 *
 *   NOBODY IS TOLD ABOUT THEIR OWN ACTION. The commonest failure of the genre.
 *
 *   ONLY PEOPLE WITH STANDING ARE TOLD. Plenty of people can SEE a task.
 *   Notifying all of them is how a bell becomes wallpaper, and a bell nobody
 *   reads is worse than no bell — it looks like the problem is solved.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DueDateType, Priority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import {
  addContributor,
  assignTask,
  createTask,
  transitionTask,
  updateTask,
} from "@/lib/tasks/service";
import { addComment } from "@/lib/tasks/comments";
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  markTaskRead,
} from "@/lib/notifications/service";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** The optimistic-lock token as it currently stands. */
async function version(taskId: bigint): Promise<string> {
  const t = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { updatedAt: true },
  });
  return t.updatedAt.toISOString();
}

async function inbox(userId: bigint) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

describe("assignment", () => {
  it("tells the person receiving the work", async () => {
    await assignTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      assigneeId: firm.users.esha,
    });

    const got = await inbox(firm.users.esha);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe("ASSIGNED_TO_ME");
    expect(got[0]!.taskId).toBe(firm.tasks.t1);
  });

  it("tells nobody when you take a task yourself", async () => {
    // Meera can manage t1 and assigns it to herself. Telling her about her own
    // click is the fastest way to teach her the bell is noise.
    await assignTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      assigneeId: firm.users.meera,
    });

    expect(await inbox(firm.users.meera)).toHaveLength(0);
  });

  it("does NOT tell the person losing the work", async () => {
    // Eshan held t1. He either handed it over or was told by his manager; a
    // bell saying "this is no longer yours" is a line nobody acts on.
    await assignTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      assigneeId: firm.users.esha,
    });

    expect(await inbox(firm.users.eshan)).toHaveLength(0);
  });

  it("tells the assignee when a task is CREATED for them", async () => {
    // Exercised separately from assignTask: creation and reassignment write
    // the notification in different places, and one working proves nothing
    // about the other.
    await createTask(actor.meera!, {
      title: "Prepare the TDS return",
      engagementId: firm.engagements.a1,
      assigneeId: firm.users.esha,
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      dueDateType: DueDateType.INTERNAL,
      priority: Priority.NORMAL,
    });

    const got = await inbox(firm.users.esha);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe("ASSIGNED_TO_ME");
  });

  it("tells nobody when you create a task for yourself", async () => {
    await createTask(actor.meera!, {
      title: "Draft the engagement letter",
      engagementId: firm.engagements.a1,
      assigneeId: firm.users.meera,
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      dueDateType: DueDateType.INTERNAL,
      priority: Priority.NORMAL,
    });

    expect(await inbox(firm.users.meera)).toHaveLength(0);
  });
});

describe("review", () => {
  /** Walk t4 (reviewer Meera, review required) from ASSIGNED to REVIEW. */
  async function submitForReview() {
    await transitionTask(actor.esha!, firm.tasks.t4, {
      expectedVersion: await version(firm.tasks.t4),
      to: TaskStatus.IN_PROGRESS,
    });
    await transitionTask(actor.esha!, firm.tasks.t4, {
      expectedVersion: await version(firm.tasks.t4),
      to: TaskStatus.REVIEW,
    });
  }

  it("tells the reviewer when work is submitted", async () => {
    await submitForReview();

    const got = await inbox(firm.users.meera);
    expect(got.map((n) => n.type)).toContain("REVIEW_REQUESTED");
  });

  it("tells the assignee when work is sent back, with the reason", async () => {
    await submitForReview();

    await transitionTask(actor.meera!, firm.tasks.t4, {
      expectedVersion: await version(firm.tasks.t4),
      to: TaskStatus.IN_PROGRESS,
      reason: "ITC reconciliation is missing",
    });

    const got = await inbox(firm.users.esha);
    const rejected = got.find((n) => n.type === "REVIEW_REJECTED");
    expect(rejected).toBeDefined();
    // The reason travels with it. A bell saying only "sent back" makes the
    // person open the task to find out what to do, every time.
    expect((rejected!.payload as { reason: string }).reason).toMatch(/ITC/);
  });

  it("says nothing on ordinary status moves", async () => {
    // Starting work, completing, cancelling: all visible on screens people
    // already look at. A bell for every status change is how the bell dies.
    await transitionTask(actor.eshan!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      to: TaskStatus.IN_PROGRESS,
    });

    expect(await inbox(firm.users.meera)).toHaveLength(0);
  });
});

describe("mentions", () => {
  it("tells the person mentioned, and nobody else", async () => {
    await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "@Meera Manager can you look at the ITC position?",
      mentions: [firm.users.meera],
    });

    const meera = await inbox(firm.users.meera);
    expect(meera).toHaveLength(1);
    expect(meera[0]!.type).toBe("MENTIONED");

    // Esha can see plenty of work but was not addressed.
    expect(await inbox(firm.users.esha)).toHaveLength(0);
  });

  it("carries an excerpt so the list reads without opening the task", async () => {
    await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "@Meera Manager the vendor invoices arrived",
      mentions: [firm.users.meera],
    });

    const got = await inbox(firm.users.meera);
    expect((got[0]!.payload as { excerpt: string }).excerpt).toMatch(/vendor invoices/);
  });

  it("never notifies someone who cannot open the task", async () => {
    // The mention list is filtered before it reaches the notifier, so a
    // crafted request cannot ring a bell for work the person has no key to.
    await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "@Chandra look",
      mentions: [firm.users.chandra],
    });

    expect(await inbox(firm.users.chandra)).toHaveLength(0);
  });

  it("does not notify you for mentioning yourself", async () => {
    await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "note to self",
      mentions: [firm.users.eshan],
    });

    expect(await inbox(firm.users.eshan)).toHaveLength(0);
  });
});

describe("deadlines", () => {
  it("tells the assignee when their deadline moves", async () => {
    await updateTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      dueDate: new Date("2026-10-15T00:00:00.000Z"),
      reason: "client asked for an extension",
    });

    const got = await inbox(firm.users.eshan);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe("DUE_DATE_CHANGED");

    const payload = got[0]!.payload as { from: string; to: string; reason: string };
    expect(payload.to).toContain("2026-10-15");
    expect(payload.reason).toMatch(/extension/);
  });

  it("says nothing for other field edits", async () => {
    // A retitle changes nothing about what the assignee should do today.
    await updateTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      title: "Prepare advance tax computation (revised)",
    });

    expect(await inbox(firm.users.eshan)).toHaveLength(0);
  });
});

describe("contributors", () => {
  it("tells the person added", async () => {
    await addContributor(actor.meera!, firm.tasks.t1, firm.users.esha);

    const got = await inbox(firm.users.esha);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe("ADDED_AS_CONTRIBUTOR");
  });
});

describe("coalescing", () => {
  it("folds repeated deadline changes into one line", async () => {
    // A manager adjusting a date three times should produce one notification,
    // not three. The latest state is what matters.
    for (const day of ["2026-10-01", "2026-10-08", "2026-10-15"]) {
      await updateTask(actor.meera!, firm.tasks.t1, {
        expectedVersion: await version(firm.tasks.t1),
        dueDate: new Date(`${day}T00:00:00.000Z`),
        reason: "moving it",
      });
    }

    const got = await inbox(firm.users.eshan);
    expect(got).toHaveLength(1);
    expect((got[0]!.payload as { to: string }).to).toContain("2026-10-15");
  });

  it("does NOT fold mentions — each one is a person talking to you", async () => {
    await addComment(actor.meera!, firm.tasks.t1, {
      bodyMd: "@Eshan first question",
      mentions: [firm.users.eshan],
    });
    await addComment(actor.meera!, firm.tasks.t1, {
      bodyMd: "@Eshan second, different question",
      mentions: [firm.users.eshan],
    });

    expect(await inbox(firm.users.eshan)).toHaveLength(2);
  });

  it("does NOT fold into a notification already read", async () => {
    // Quietly mutating a row someone has looked at would hide the new event
    // entirely — they have no reason to look again.
    await updateTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      dueDate: new Date("2026-10-01T00:00:00.000Z"),
      reason: "first move",
    });
    await markAllRead(actor.eshan!);

    await updateTask(actor.meera!, firm.tasks.t1, {
      expectedVersion: await version(firm.tasks.t1),
      dueDate: new Date("2026-10-08T00:00:00.000Z"),
      reason: "second move",
    });

    const got = await inbox(firm.users.eshan);
    expect(got).toHaveLength(2);
    expect(await countUnread(firm.users.eshan)).toBe(1);
  });
});

describe("reading", () => {
  async function twoNotifications() {
    await addComment(actor.meera!, firm.tasks.t1, {
      bodyMd: "@Eshan one",
      mentions: [firm.users.eshan],
    });
    await addComment(actor.meera!, firm.tasks.t6, {
      bodyMd: "@Eshan two",
      mentions: [firm.users.eshan],
    });
  }

  it("counts what is unread", async () => {
    await twoNotifications();
    expect(await countUnread(firm.users.eshan)).toBe(2);
  });

  it("marks one read", async () => {
    await twoNotifications();
    const got = await inbox(firm.users.eshan);

    expect(await markRead(actor.eshan!, [got[0]!.id])).toBe(1);
    expect(await countUnread(firm.users.eshan)).toBe(1);
  });

  it("REFUSES to mark someone else's notification read", async () => {
    await twoNotifications();
    const got = await inbox(firm.users.eshan);

    // Esha passing Eshan's id updates nothing. Written as userId in the WHERE
    // rather than a lookup-then-check, so there is no window between the two.
    expect(await markRead(actor.esha!, [got[0]!.id])).toBe(0);
    expect(await countUnread(firm.users.eshan)).toBe(2);
  });

  it("marks all read", async () => {
    await twoNotifications();
    expect(await markAllRead(actor.eshan!)).toBe(2);
    expect(await countUnread(firm.users.eshan)).toBe(0);
  });

  it("marks a task's notifications read when the task is opened", async () => {
    await twoNotifications();

    expect(await markTaskRead(actor.eshan!, firm.tasks.t1)).toBe(1);
    expect(await countUnread(firm.users.eshan)).toBe(1);
  });

  it("lists newest first", async () => {
    await twoNotifications();
    const list = await listNotifications(actor.eshan!);

    expect(list).toHaveLength(2);
    expect(list[0]!.taskId).toBe(firm.tasks.t6);
  });

  it("shows only your own", async () => {
    await twoNotifications();
    expect(await listNotifications(actor.esha!)).toHaveLength(0);
  });

  it("filters to unread on request", async () => {
    await twoNotifications();
    const all = await inbox(firm.users.eshan);
    await markRead(actor.eshan!, [all[0]!.id]);

    expect(await listNotifications(actor.eshan!, { unreadOnly: true })).toHaveLength(1);
    expect(await listNotifications(actor.eshan!)).toHaveLength(2);
  });
});
