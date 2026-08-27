/**
 * The client directory.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * This page is built entirely from `visibleTaskFilter`, and what it discloses
 * if that goes wrong is not a task title — it is the firm's client list, which
 * is commercially sensitive in a different way.
 *
 * The counts matter too. A wrong total on a dashboard looks exactly like a
 * right one, nobody can check it by eye, and decisions get made on it.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { EngagementStatus, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { getClientDirectory } from "@/lib/clients/directory";

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

describe("scope", () => {
  it("shows a client only because you have work on it", async () => {
    // Eshan works on EngA1 (Alpha) alone. Beta must not appear — he has no
    // relationship to any of its work, and its very existence is not his to
    // know from this page.
    const dir = await getClientDirectory(actor.eshan!);
    const codes = dir.map((c) => c.code);

    expect(codes).toContain("ALPHA");
    expect(codes).not.toContain("BETA");
  });

  it("shows nothing at all to someone related to nothing", async () => {
    expect(await getClientDirectory(actor.chandra!)).toHaveLength(0);
  });

  it("shows an admin every client", async () => {
    const codes = (await getClientDirectory(actor.admin!)).map((c) => c.code);
    expect(codes).toContain("ALPHA");
    expect(codes).toContain("BETA");
  });

  it("lists only the engagements you can reach within a client", async () => {
    // Alpha holds two engagements: A1 (Eshan's) and A2 (audit, Nikhil's).
    // Eshan sees the client through A1 and must not learn A2 exists.
    const dir = await getClientDirectory(actor.eshan!);
    const alpha = dir.find((c) => c.code === "ALPHA")!;

    expect(alpha.engagements.map((e) => e.name)).toEqual(["Tax Compliance"]);
  });
});

describe("counts", () => {
  it("totals open work per engagement and rolls it up to the client", async () => {
    const dir = await getClientDirectory(actor.admin!);
    const alpha = dir.find((c) => c.code === "ALPHA")!;

    const summed = alpha.engagements.reduce((n, e) => n + e.openTasks, 0);
    expect(alpha.openTasks).toBe(summed);
    expect(alpha.openTasks).toBeGreaterThan(0);
  });

  it("counts overdue work, in the organisation's day", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { dueDate: daysFromNow(-3), status: TaskStatus.IN_PROGRESS },
    });

    const dir = await getClientDirectory(actor.admin!);
    const alpha = dir.find((c) => c.code === "ALPHA")!;

    expect(alpha.overdue).toBe(1);
    expect(alpha.engagements.find((e) => e.name === "Tax Compliance")!.overdue).toBe(1);
  });

  it("excludes finished work from the open count", async () => {
    const before = (await getClientDirectory(actor.admin!)).find(
      (c) => c.code === "ALPHA"
    )!.openTasks;

    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { status: TaskStatus.COMPLETED },
    });

    const after = (await getClientDirectory(actor.admin!)).find(
      (c) => c.code === "ALPHA"
    )!.openTasks;

    expect(after).toBe(before - 1);
  });

  it("INCLUDES finished work in the hours — unlike the dashboard", async () => {
    // Different question. The dashboard asks what is in flight; this page asks
    // what an engagement has cost, and excluding completed work would answer
    // something nobody asked.
    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { status: TaskStatus.COMPLETED, actualMinutes: 240 },
    });

    const dir = await getClientDirectory(actor.admin!);
    const eng = dir
      .find((c) => c.code === "ALPHA")!
      .engagements.find((e) => e.name === "Tax Compliance")!;

    expect(eng.loggedMinutes).toBeGreaterThanOrEqual(240);
  });
});

describe("ordering and closed work", () => {
  it("puts clients with overdue work first", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t4 }, // Beta
      data: { dueDate: daysFromNow(-5), status: TaskStatus.IN_PROGRESS },
    });

    const dir = await getClientDirectory(actor.admin!);
    expect(dir[0]!.code).toBe("BETA");
  });

  it("SHOWS a closed engagement rather than hiding it", async () => {
    // Last year's audit is a real thing people look for. A page that silently
    // omits it invites the conclusion that the work was never recorded.
    await prisma.engagement.update({
      where: { id: firm.engagements.a2 },
      data: { status: EngagementStatus.CLOSED },
    });

    const dir = await getClientDirectory(actor.admin!);
    const alpha = dir.find((c) => c.code === "ALPHA")!;
    const audit = alpha.engagements.find((e) => e.name === "Statutory Audit");

    expect(audit).toBeDefined();
    expect(audit!.status).toBe("CLOSED");
  });

  it("sorts live engagements above closed ones", async () => {
    await prisma.engagement.update({
      where: { id: firm.engagements.a1 },
      data: { status: EngagementStatus.CLOSED },
    });
    // A1 closed: its tasks stop counting as open, so it should fall below A2.
    await prisma.task.updateMany({
      where: { engagementId: firm.engagements.a1 },
      data: { status: TaskStatus.COMPLETED },
    });

    const dir = await getClientDirectory(actor.admin!);
    const alpha = dir.find((c) => c.code === "ALPHA")!;

    expect(alpha.engagements[0]!.name).toBe("Statutory Audit");
  });

  it("names the partner and manager, so a row says who to ask", async () => {
    const dir = await getClientDirectory(actor.admin!);
    const eng = dir
      .find((c) => c.code === "ALPHA")!
      .engagements.find((e) => e.name === "Tax Compliance")!;

    expect(eng.partnerName).toBe("Priya Partner");
    expect(eng.managerName).toBe("Meera Manager");
  });
});
