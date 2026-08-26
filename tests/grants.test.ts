/**
 * The database grants, tested through a genuinely restricted connection.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Every other test in this suite connects as ontrack_owner, which can do
 * anything. This file is the exception: it opens a second client on the
 * ontrack_app connection string — the same one the running application will
 * use — and confirms the privileges actually withheld.
 *
 * WHY BOTHER, given the application never tries to do these things?
 *
 * Because "the application never updates the activity log" is a convention,
 * and conventions last until someone writes a well-meaning cleanup script, or
 * a future contributor reaches for `prisma.task.delete()` because it is the
 * obvious method name. The grants turn that from a silent data loss into an
 * immediate, loud failure in development.
 *
 * These are two independent layers. The application kernel decides who may
 * see and change what; the grants are a backstop for when the kernel is
 * bypassed entirely. Testing them separately keeps a failure unambiguous.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityAction, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./helpers/db";
import { buildFirm, type Firm } from "./helpers/fixtures";

let firm: Firm;
let app: PrismaClient;
let activityId: bigint;

beforeAll(async () => {
  const url = process.env.TEST_APP_DATABASE_URL;
  if (!url) throw new Error("TEST_APP_DATABASE_URL not set — see tests/setup.ts");

  // The restricted connection: ontrack_app on ontrack_test.
  app = new PrismaClient({ datasourceUrl: url });

  await resetDatabase();
  firm = await buildFirm();

  const entry = await prisma.activityLog.create({
    data: {
      taskId: firm.tasks.t1,
      actorId: firm.users.meera,
      action: ActivityAction.TASK_CREATED,
    },
  });
  activityId = entry.id;
});

afterAll(async () => {
  await app?.$disconnect();
});

describe("the application role is who we think it is", () => {
  it("connects as ontrack_app", async () => {
    const rows = await app.$queryRaw<{ who: string }[]>`SELECT current_user AS who`;
    expect(rows[0]?.who).toBe("ontrack_app");
  });

  it("is pointed at the test database", async () => {
    const rows = await app.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(rows[0]?.db).toBe("ontrack_test");
  });
});

describe("activity log is append-only", () => {
  it("can INSERT", async () => {
    const created = await app.activityLog.create({
      data: {
        taskId: firm.tasks.t1,
        actorId: firm.users.meera,
        action: ActivityAction.STATUS_CHANGED,
        field: "status",
        oldValue: "ASSIGNED",
        newValue: "IN_PROGRESS",
      },
    });
    expect(created.id).toBeDefined();
  });

  it("can SELECT", async () => {
    const rows = await app.activityLog.findMany({ where: { taskId: firm.tasks.t1 } });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CANNOT UPDATE — history is not editable", async () => {
    await expect(
      app.activityLog.update({
        where: { id: activityId },
        data: { reason: "quietly rewriting the past" },
      })
    ).rejects.toThrow(/permission denied/i);
  });

  it("CANNOT DELETE — history is not erasable", async () => {
    await expect(
      app.activityLog.delete({ where: { id: activityId } })
    ).rejects.toThrow(/permission denied/i);
  });

  it("the row is still there after both attempts", async () => {
    const still = await prisma.activityLog.findUnique({ where: { id: activityId } });
    expect(still).not.toBeNull();
    expect(still?.reason).toBeNull();
  });
});

describe("deletion is always soft", () => {
  it("CANNOT hard-delete a task", async () => {
    await expect(app.task.delete({ where: { id: firm.tasks.t1 } })).rejects.toThrow(
      /permission denied/i
    );
  });

  it("CAN soft-delete one, which is the supported path", async () => {
    const updated = await app.task.update({
      where: { id: firm.tasks.t1 },
      data: { deletedAt: new Date() },
    });
    expect(updated.deletedAt).not.toBeNull();

    await app.task.update({ where: { id: firm.tasks.t1 }, data: { deletedAt: null } });
  });

  it("CANNOT hard-delete a time entry", async () => {
    const entry = await prisma.timeEntry.create({
      data: {
        taskId: firm.tasks.t1,
        userId: firm.users.eshan,
        workDate: new Date("2026-08-26T00:00:00.000Z"),
        durationMinutes: 30,
      },
    });

    await expect(app.timeEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /permission denied/i
    );
  });

  it("CANNOT hard-delete a user — leavers are deactivated, never removed", async () => {
    await expect(app.user.delete({ where: { id: firm.users.chandra } })).rejects.toThrow(
      /permission denied/i
    );
  });

  it("CANNOT hard-delete a comment — comments are part of the work record", async () => {
    const comment = await prisma.comment.create({
      data: {
        taskId: firm.tasks.t1,
        authorId: firm.users.meera,
        bodyMd: "Please attach the reconciliation.",
      },
    });

    await expect(app.comment.delete({ where: { id: comment.id } })).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe("join rows genuinely are removable", () => {
  it("can remove a contributor — nothing is lost, and the removal is logged", async () => {
    const link = await prisma.taskContributor.create({
      data: { taskId: firm.tasks.t2, userId: firm.users.esha, addedById: firm.users.meera },
    });

    await expect(app.taskContributor.delete({ where: { id: link.id } })).resolves.toBeDefined();
  });

  it("can clear a notification", async () => {
    const n = await prisma.notification.create({
      data: { userId: firm.users.eshan, type: "ASSIGNED_TO_ME", taskId: firm.tasks.t1 },
    });

    await expect(app.notification.delete({ where: { id: n.id } })).resolves.toBeDefined();
  });
});

describe("ordinary work is unaffected", () => {
  it("can read tasks", async () => {
    expect(await app.task.count()).toBeGreaterThan(0);
  });

  it("can create a task", async () => {
    const created = await app.task.create({
      data: {
        displayKey: "TSK-TEST-9001",
        title: "Created by the application role",
        engagementId: firm.engagements.a1,
        createdById: firm.users.meera,
        assigneeId: firm.users.eshan,
        dueDate: new Date("2026-09-30T00:00:00.000Z"),
        reviewRequired: false,
      },
    });
    expect(created.displayKey).toBe("TSK-TEST-9001");
  });

  it("can update a task and log time", async () => {
    await expect(
      app.task.update({ where: { id: firm.tasks.t2 }, data: { title: "Retitled" } })
    ).resolves.toBeDefined();

    await expect(
      app.timeEntry.create({
        data: {
          taskId: firm.tasks.t2,
          userId: firm.users.meera,
          workDate: new Date("2026-08-26T00:00:00.000Z"),
          durationMinutes: 45,
        },
      })
    ).resolves.toBeDefined();
  });
});
