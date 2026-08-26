/**
 * A small fictional firm, built fresh for each test file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The shape of this fixture is the argument for the whole visibility model,
 * so it is worth reading before the assertions.
 *
 *   PEOPLE                                WORK
 *   ──────                                ────
 *   admin        Admin                    Client A  (partner: Priya)
 *   Priya        Partner, Client A          EngA1  Tax    mgr Meera   [Meera, Eshan]
 *   Quentin      Partner, Client B          EngA2  Audit  mgr Nikhil  [Nikhil, Ellie]
 *   Meera        Manager, Tax             Client B  (partner: Quentin)
 *   Nikhil       Manager, Audit             EngB1  Tax    mgr Meera   [Meera, Esha, Ellie]
 *   Eshan        Member, Tax  → Meera
 *   Esha         Member, Tax  → Meera
 *   Ellie        Member, Audit → Nikhil
 *   Chandra      Member, no team, no manager, no engagements
 *
 * THE CASE THAT MATTERS: Ellie is on the Audit team and reports to Nikhil,
 * but works on EngB1, a Tax engagement managed by Meera. A hierarchical
 * "managers see their team" model gets this wrong in both directions — Meera
 * cannot see work she is responsible for, and Ellie's access depends on an
 * org chart that has nothing to do with the engagement. This is the single
 * most common real situation in a CA firm and the reason visibility is a
 * union of relationships rather than a tree walk.
 *
 * Chandra exists to prove the negative: a valid, active user with no
 * relationship to anything must see nothing at all.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { EngagementCapacity, Grade, Role, TaskStatus, UserStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface Firm {
  users: {
    admin: bigint;
    priya: bigint;
    quentin: bigint;
    meera: bigint;
    nikhil: bigint;
    eshan: bigint;
    esha: bigint;
    ellie: bigint;
    chandra: bigint;
  };
  clients: { a: bigint; b: bigint };
  engagements: { a1: bigint; a2: bigint; b1: bigint };
  tasks: {
    /** EngA1, assigned to Eshan, created by Meera */
    t1: bigint;
    /** EngA1, assigned to Meera herself */
    t2: bigint;
    /** EngA2, assigned to Ellie, created by Nikhil */
    t3: bigint;
    /** EngB1, assigned to Esha, reviewed by Meera */
    t4: bigint;
    /** EngB1, assigned to Ellie — the cross-team case */
    t5: bigint;
    /** EngA1, assigned to Eshan, with Esha as a CONTRIBUTOR */
    t6: bigint;
  };
}

const DUE = new Date("2026-09-30T00:00:00.000Z");

export async function buildFirm(): Promise<Firm> {
  const tax = await prisma.team.create({ data: { name: "Direct Tax" } });
  const audit = await prisma.team.create({ data: { name: "Statutory Audit" } });

  const mk = (
    email: string,
    name: string,
    role: Role,
    grade: Grade,
    teamId?: bigint,
    reportsToId?: bigint
  ) =>
    prisma.user.create({
      data: {
        email,
        name,
        role,
        grade,
        status: UserStatus.ACTIVE,
        teamId: teamId ?? null,
        reportsToId: reportsToId ?? null,
      },
    });

  // .invalid is reserved by RFC 2606 and can never be a real domain, so these
  // addresses cannot collide with a real person if fixtures ever leak.
  const admin = await mk("admin@example.invalid", "Ada Admin", Role.ADMIN, Grade.DIRECTOR);
  const priya = await mk("priya@example.invalid", "Priya Partner", Role.PARTNER, Grade.PARTNER);
  const quentin = await mk("quentin@example.invalid", "Quentin Partner", Role.PARTNER, Grade.PARTNER);
  const meera = await mk("meera@example.invalid", "Meera Manager", Role.MANAGER, Grade.MANAGER, tax.id);
  const nikhil = await mk("nikhil@example.invalid", "Nikhil Manager", Role.MANAGER, Grade.MANAGER, audit.id);

  const eshan = await mk("eshan@example.invalid", "Eshan Exec", Role.MEMBER, Grade.SENIOR, tax.id, meera.id);
  const esha = await mk("esha@example.invalid", "Esha Exec", Role.MEMBER, Grade.EXECUTIVE, tax.id, meera.id);
  const ellie = await mk("ellie@example.invalid", "Ellie Exec", Role.MEMBER, Grade.EXECUTIVE, audit.id, nikhil.id);
  const chandra = await mk("chandra@example.invalid", "Chandra Contractor", Role.MEMBER, Grade.EXECUTIVE);

  const clientA = await prisma.client.create({
    data: { name: "Alpha Industries", code: "ALPHA", relationshipPartnerId: priya.id },
  });
  const clientB = await prisma.client.create({
    data: { name: "Beta Traders", code: "BETA", relationshipPartnerId: quentin.id },
  });

  const engA1 = await prisma.engagement.create({
    data: {
      clientId: clientA.id, name: "Tax Compliance", fy: "2026-27",
      teamId: tax.id, partnerId: priya.id, managerId: meera.id,
    },
  });
  const engA2 = await prisma.engagement.create({
    data: {
      clientId: clientA.id, name: "Statutory Audit", fy: "2026-27",
      teamId: audit.id, partnerId: priya.id, managerId: nikhil.id,
    },
  });
  const engB1 = await prisma.engagement.create({
    data: {
      clientId: clientB.id, name: "GST Compliance", fy: "2026-27",
      teamId: tax.id, partnerId: quentin.id, managerId: meera.id,
    },
  });

  const member = (engagementId: bigint, userId: bigint, capacity: EngagementCapacity) =>
    prisma.engagementMember.create({ data: { engagementId, userId, capacity } });

  await member(engA1.id, meera.id, EngagementCapacity.MANAGER);
  await member(engA1.id, eshan.id, EngagementCapacity.MEMBER);

  await member(engA2.id, nikhil.id, EngagementCapacity.MANAGER);
  await member(engA2.id, ellie.id, EngagementCapacity.MEMBER);

  await member(engB1.id, meera.id, EngagementCapacity.MANAGER);
  await member(engB1.id, esha.id, EngagementCapacity.MEMBER);
  // The cross-team staffing: Ellie is Audit and reports to Nikhil.
  await member(engB1.id, ellie.id, EngagementCapacity.MEMBER);

  const task = (
    key: string, title: string, engagementId: bigint,
    createdById: bigint, assigneeId: bigint,
    extra: { reviewerId?: bigint; status?: TaskStatus; reviewRequired?: boolean } = {}
  ) =>
    prisma.task.create({
      data: {
        displayKey: key, title, engagementId,
        createdById, assignedById: createdById, assigneeId,
        dueDate: DUE,
        reviewRequired: extra.reviewRequired ?? false,
        reviewerId: extra.reviewerId ?? null,
        status: extra.status ?? TaskStatus.ASSIGNED,
        currentEstimateMinutes: 120,
      },
    });

  const t1 = await task("TSK-TEST-0001", "Prepare advance tax computation", engA1.id, meera.id, eshan.id);
  const t2 = await task("TSK-TEST-0002", "Review client TDS position", engA1.id, meera.id, meera.id);
  const t3 = await task("TSK-TEST-0003", "Vouching of purchases", engA2.id, nikhil.id, ellie.id);
  const t4 = await task("TSK-TEST-0004", "File GSTR-3B", engB1.id, meera.id, esha.id, {
    reviewerId: meera.id, reviewRequired: true,
  });
  const t5 = await task("TSK-TEST-0005", "Reconcile GSTR-2B", engB1.id, meera.id, ellie.id);
  const t6 = await task("TSK-TEST-0006", "Draft tax notes", engA1.id, meera.id, eshan.id);

  // Esha contributes to a task on an engagement she is NOT a member of.
  await prisma.taskContributor.create({
    data: { taskId: t6.id, userId: esha.id, addedById: eshan.id },
  });

  return {
    users: {
      admin: admin.id, priya: priya.id, quentin: quentin.id,
      meera: meera.id, nikhil: nikhil.id,
      eshan: eshan.id, esha: esha.id, ellie: ellie.id, chandra: chandra.id,
    },
    clients: { a: clientA.id, b: clientB.id },
    engagements: { a1: engA1.id, a2: engA2.id, b1: engB1.id },
    tasks: { t1: t1.id, t2: t2.id, t3: t3.id, t4: t4.id, t5: t5.id, t6: t6.id },
  };
}
