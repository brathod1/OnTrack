/**
 * OnTrack — development seed data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ ALL DATA HERE IS FICTIONAL. No real employee, client or engagement
 * appears. Every address is @demo.invalid — `.invalid` is reserved by
 * RFC 2606 and can never be a real domain, so nothing here can accidentally
 * email a real person.
 *
 * WHY IT IS THIS DETAILED: every dashboard, filter and report built over the
 * next ten stages gets designed against this data. Seed three tasks and you
 * design a UI for a world with three tasks — one that falls apart the first
 * time a manager opens it with two hundred. So this seeds a plausible slice of
 * a real firm: overdue work, blocked work, an article's tasks awaiting review,
 * a running timer, estimates that were wrong in both directions.
 *
 * DATES ARE RELATIVE TO TODAY, so "due today" and "overdue" stay meaningful
 * whenever you re-seed. Hardcoded dates rot within a week.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   npm run db:seed
 *
 * Connects as ontrack_owner (DIRECT_DATABASE_URL), not ontrack_app: seeding
 * wipes existing rows, and the application role deliberately has no DELETE.
 */

import {
  ActivityAction,
  EngagementCapacity,
  NotificationType,
  PrismaClient,
  Priority,
  TaskStatus,
  TimeEntrySource,
  UserStatus,
  DueDateType,
} from "@prisma/client";
import { DEFAULT_ROLES } from "../src/lib/auth/capabilities";

const db = new PrismaClient({
  datasourceUrl: process.env.DIRECT_DATABASE_URL,
  log: ["warn", "error"],
});

// ── Date helpers ────────────────────────────────────────────────────────────

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** A calendar date N days from today. Negative is the past. */
const day = (offset: number) => {
  const d = startOfToday();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

/** A timestamp N hours ago. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const hours = (h: number) => Math.round(h * 60);

// ── Guards ──────────────────────────────────────────────────────────────────

async function assertSafeToSeed() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }

  const rows = await db.$queryRaw<{ db: string; who: string }[]>`
    SELECT current_database() AS db, current_user AS who
  `;
  const current = rows[0];

  if (!current || !["ontrack", "ontrack_test"].includes(current.db)) {
    throw new Error(
      `Refusing to seed: connected to "${current?.db}". Expected ontrack or ontrack_test.`
    );
  }

  if (current.who !== "ontrack_owner") {
    throw new Error(
      `Refusing to seed: connected as "${current.who}". Seeding needs ontrack_owner ` +
        `(DIRECT_DATABASE_URL) because it deletes rows, and ontrack_app has no DELETE.`
    );
  }

  console.log(`  Seeding "${current.db}" as ${current.who}`);
}

const TABLES = [
  "organizations",
  "activity_log", "notifications", "time_entries", "task_contributors",
  "task_tags", "comments", "attachments", "tasks", "recurrence_instances",
  "recurrence_rules", "engagement_members", "engagements", "clients",
  "saved_views", "tags", "users", "teams", "settings", "task_key_counters",
];

async function wipe() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
  console.log("  Existing data cleared");
}

async function nextTaskKey(): Promise<string> {
  const rows = await db.$queryRaw<{ key: string }[]>`SELECT next_task_key() AS key`;
  return rows[0]!.key;
}

// ── The firm ────────────────────────────────────────────────────────────────

async function main() {
  await assertSafeToSeed();
  await wipe();

  // ── The organisation ─────────────────────────────────────────────────────
  //
  // THIS IS WHERE THE CA FIRM LIVES. Everything below is configuration for one
  // organisation, not behaviour of the software. Another organisation gets a
  // different row here — different timezone, different vocabulary, different
  // service lines — and runs the same engine.
  //
  // The application contains no `if (organisation is a CA firm)` anywhere. If
  // it ever does, that is the bug this structure exists to prevent.
  const org = await db.organization.create({
    data: {
      name: "Demo Chartered Accountants LLP",
      shortName: "DemoCA",
      timezone: "Asia/Kolkata",
      dateFormat: "dd MMM yyyy",
      weekStartsOn: 1,
      workingDays: [1, 2, 3, 4, 5, 6], // Mon-Sat, as most Indian firms work
      taskKeyPrefix: "TSK",
      searchLanguage: "english",

      // What this organisation calls things. A software company would set
      // client → Customer and engagement → Project; nothing else changes.
      terminology: {
        client: { singular: "Client", plural: "Clients" },
        engagement: { singular: "Engagement", plural: "Engagements" },
        task: { singular: "Task", plural: "Tasks" },
        subtask: { singular: "Subtask", plural: "Subtasks" },
        review: { singular: "Review", verb: "Review" },
        externalDeadline: { singular: "Statutory deadline", short: "Stat" },
        team: { singular: "Team", plural: "Teams" },
      },
    },
  });

  console.log(`  Organisation: ${org.name}`);

  // ── Roles ────────────────────────────────────────────────────────────────
  // Also configuration. This firm gets Administrator / Partner / Senior /
  // Staff because that is what a CA firm calls these people. An administrator
  // can rename any of them, or move a capability between them, without a
  // deployment — nothing in the engine looks a role up by name.
  await db.role.createMany({
    data: DEFAULT_ROLES.map((r) => ({
      organizationId: org.id,
      key: r.key,
      label: r.label,
      description: r.description,
      capabilities: [...r.capabilities],
      isSystem: r.isSystem,
      sortOrder: r.sortOrder,
    })),
  });

  const roleRows = await db.role.findMany({
    where: { organizationId: org.id },
    select: { id: true, key: true, label: true },
  });
  const roleId = (key: string): bigint => {
    const found = roleRows.find((r) => r.key === key);
    if (!found) throw new Error(`Seed role "${key}" not found`);
    return found.id;
  };

  console.log(`  Roles: ${roleRows.map((r) => r.label).join(", ")}`);

  // ── Teams (service lines) ────────────────────────────────────────────────
  // Configuration too. These are this firm's service lines, not categories the
  // engine knows about.
  const [audit, directTax, gst, internalAudit, admin_] = await Promise.all([
    db.team.create({ data: { name: "Statutory Audit", organizationId: org.id } }),
    db.team.create({ data: { name: "Direct Tax", organizationId: org.id } }),
    db.team.create({ data: { name: "Indirect Tax / GST", organizationId: org.id } }),
    db.team.create({ data: { name: "Internal Audit & Risk", organizationId: org.id } }),
    db.team.create({
      data: {
        name: "Practice Administration",
        organizationId: org.id,
        membersCanCreateTasks: false,
      },
    }),
  ]);

  // ── People ───────────────────────────────────────────────────────────────
  // Deliberately named so their role is obvious at a glance in the UI.
  // `grade` is free text now: this firm's seniority ladder, not the engine's.
  const mk = (
    email: string, name: string, roleKey: string, grade: string,
    teamId?: bigint, reportsToId?: bigint
  ) =>
    db.user.create({
      data: {
        email, name, grade,
        roleId: roleId(roleKey),
        status: UserStatus.ACTIVE,
        organizationId: org.id,
        teamId: teamId ?? null,
        reportsToId: reportsToId ?? null,
      },
    });

  const aarti = await mk("admin@demo.invalid", "Aarti Admin", "admin", "Director", admin_.id);
  const raghav = await mk("partner.rao@demo.invalid", "Raghav Rao", "partner", "Partner");
  const sneha = await mk("partner.shah@demo.invalid", "Sneha Shah", "partner", "Partner");

  const kavya = await mk("manager.iyer@demo.invalid", "Kavya Iyer", "senior", "Manager", directTax.id);
  const rohit = await mk("manager.desai@demo.invalid", "Rohit Desai", "senior", "Manager", audit.id);

  const anjali = await mk("exec.nair@demo.invalid", "Anjali Nair", "staff", "Senior", directTax.id, kavya.id);
  const vikram = await mk("exec.gupta@demo.invalid", "Vikram Gupta", "staff", "Executive", gst.id, kavya.id);
  const divya = await mk("exec.menon@demo.invalid", "Divya Menon", "staff", "Executive", audit.id, rohit.id);
  // "Article" is an articled clerk — this firm's term, now just a string.
  const karan = await mk("article.jain@demo.invalid", "Karan Jain", "staff", "Article", audit.id, rohit.id);

  // Someone who has signed in via Entra but not yet been approved. Exists so
  // the admin approval queue has something in it from day one.
  await db.user.create({
    data: {
      email: "newjoiner@demo.invalid", name: "Pending Newjoiner",
      roleId: roleId("staff"), grade: "Executive", status: UserStatus.PENDING,
      organizationId: org.id,
    },
  });

  // A leaver: deactivated, retains history, must not appear in pickers.
  await db.user.create({
    data: {
      email: "former.staff@demo.invalid", name: "Former Staff",
      roleId: roleId("staff"), grade: "Executive", status: UserStatus.INACTIVE,
      organizationId: org.id,
      teamId: audit.id, reportsToId: rohit.id, deactivatedAt: hoursAgo(24 * 40),
    },
  });

  // ── Clients ──────────────────────────────────────────────────────────────
  const firmInternal = await db.client.create({
    data: {
      name: "Firm — Internal", code: "INTERNAL", isInternal: true,
      organizationId: org.id, relationshipPartnerId: aarti.id,
    },
  });
  const orchid = await db.client.create({
    data: {
      name: "Orchid Textiles Pvt Ltd", code: "ORCHID", aliases: ["Orchid Mills"],
      organizationId: org.id, relationshipPartnerId: raghav.id,
    },
  });
  const vertex = await db.client.create({
    data: {
      name: "Vertex Logistics Ltd", code: "VERTEX",
      organizationId: org.id, relationshipPartnerId: sneha.id,
    },
  });
  const meridian = await db.client.create({
    data: {
      name: "Meridian Foods Pvt Ltd", code: "MERIDIAN",
      organizationId: org.id, relationshipPartnerId: raghav.id,
    },
  });

  // ── Engagements ──────────────────────────────────────────────────────────
  const eng = (
    clientId: bigint, name: string, fy: string | null, teamId: bigint,
    partnerId: bigint, managerId: bigint, defaultReviewRequired = true
  ) =>
    db.engagement.create({
      data: { clientId, name, fy, teamId, partnerId, managerId, defaultReviewRequired },
    });

  const orchidGst = await eng(orchid.id, "GST Compliance", "2026-27", gst.id, raghav.id, kavya.id);
  const orchidAudit = await eng(orchid.id, "Statutory Audit", "2025-26", audit.id, raghav.id, rohit.id);
  const vertexTax = await eng(vertex.id, "TDS & Advance Tax", "2026-27", directTax.id, sneha.id, kavya.id);
  const meridianAudit = await eng(meridian.id, "Statutory Audit", "2025-26", audit.id, raghav.id, rohit.id);
  const meridianIa = await eng(meridian.id, "Internal Audit", "2026-27", internalAudit.id, raghav.id, rohit.id);
  const practiceAdmin = await eng(firmInternal.id, "Practice Administration", null, admin_.id, aarti.id, aarti.id, false);

  // ── Engagement membership ────────────────────────────────────────────────
  const member = (engagementId: bigint, userId: bigint, capacity: EngagementCapacity) =>
    db.engagementMember.create({ data: { engagementId, userId, capacity } });

  await member(orchidGst.id, kavya.id, EngagementCapacity.MANAGER);
  await member(orchidGst.id, vikram.id, EngagementCapacity.IN_CHARGE);

  await member(orchidAudit.id, rohit.id, EngagementCapacity.MANAGER);
  await member(orchidAudit.id, divya.id, EngagementCapacity.IN_CHARGE);
  await member(orchidAudit.id, karan.id, EngagementCapacity.MEMBER);

  await member(vertexTax.id, kavya.id, EngagementCapacity.MANAGER);
  await member(vertexTax.id, anjali.id, EngagementCapacity.IN_CHARGE);
  // Cross-team staffing: Vikram is GST, reports to Kavya, but helps on a
  // Direct Tax engagement. The case a pure hierarchy gets wrong.
  await member(vertexTax.id, vikram.id, EngagementCapacity.MEMBER);

  await member(meridianAudit.id, rohit.id, EngagementCapacity.MANAGER);
  await member(meridianAudit.id, karan.id, EngagementCapacity.MEMBER);
  // Anjali is Direct Tax but is staffed onto an audit — again deliberate.
  await member(meridianAudit.id, anjali.id, EngagementCapacity.MEMBER);

  await member(meridianIa.id, rohit.id, EngagementCapacity.MANAGER);
  await member(meridianIa.id, divya.id, EngagementCapacity.IN_CHARGE);

  await member(practiceAdmin.id, aarti.id, EngagementCapacity.MANAGER);

  // ── Tags ─────────────────────────────────────────────────────────────────
  const [urgent, clientWaiting, firstYear] = await Promise.all([
    db.tag.create({ data: { name: "urgent", color: "#dc2626" } }),
    db.tag.create({ data: { name: "waiting-on-client", color: "#ea580c" } }),
    db.tag.create({ data: { name: "first-year", color: "#2563eb" } }),
  ]);

  // ── Tasks ────────────────────────────────────────────────────────────────
  interface TaskSpec {
    title: string;
    engagementId: bigint;
    createdById: bigint;
    assigneeId: bigint;
    dueOffset: number;
    status?: TaskStatus;
    priority?: Priority;
    reviewerId?: bigint;
    reviewRequired?: boolean;
    estimate?: number;
    actual?: number;
    dueDateType?: DueDateType;
    externalDeadlineOffset?: number;
    blockedReason?: string;
    description?: string;
    startedDaysAgo?: number;
    completedDaysAgo?: number;
    reviewRound?: number;
    parentOf?: string[];
    tagIds?: bigint[];
    cancelReason?: string;
  }

  const specs: TaskSpec[] = [
    // ── Overdue: the thing a manager must see first ───────────────────────
    {
      title: "GSTR-3B — July 2026",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: -6, externalDeadlineOffset:-6, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.IN_PROGRESS, priority: Priority.CRITICAL,
      reviewerId: kavya.id, estimate: hours(3), actual: hours(4.5),
      startedDaysAgo: 8, tagIds: [urgent.id],
      description: "Outward supplies reconciled. ITC still under review — vendor invoices missing for two suppliers.",
    },
    {
      title: "TDS return 26Q — Q1 FY 2026-27",
      engagementId: vertexTax.id, createdById: kavya.id, assigneeId: anjali.id,
      dueOffset: -2, externalDeadlineOffset:-2, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.REVIEW, priority: Priority.HIGH,
      reviewerId: kavya.id, estimate: hours(4), actual: hours(5.25),
      startedDaysAgo: 5, tagIds: [urgent.id],
    },
    // ── Blocked: In Progress AND blocked, which is the whole point ─────────
    {
      title: "Verify closing stock valuation",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: 3, status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH,
      reviewerId: rohit.id, estimate: hours(6), actual: hours(2),
      startedDaysAgo: 4,
      blockedReason: "Awaiting stock count sheets from the client's Surat warehouse",
      tagIds: [clientWaiting.id],
    },
    // ── Due today ─────────────────────────────────────────────────────────
    {
      title: "Advance tax computation — Q2",
      engagementId: vertexTax.id, createdById: kavya.id, assigneeId: anjali.id,
      dueOffset: 0, status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH,
      reviewerId: kavya.id, estimate: hours(3), actual: hours(1.5), startedDaysAgo: 1,
    },
    {
      title: "Circulate audit planning memorandum",
      engagementId: meridianAudit.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: 0, status: TaskStatus.ASSIGNED, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(2),
    },
    // ── This week ─────────────────────────────────────────────────────────
    {
      title: "GSTR-1 — August 2026",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: 4, externalDeadlineOffset:4, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.ASSIGNED, priority: Priority.HIGH,
      reviewerId: kavya.id, estimate: hours(2.5),
    },
    {
      title: "Vouching of purchases — sample selection",
      engagementId: meridianAudit.id, createdById: rohit.id, assigneeId: karan.id,
      dueOffset: 5, status: TaskStatus.IN_PROGRESS, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(8), actual: hours(3), startedDaysAgo: 2,
      tagIds: [firstYear.id],
    },
    {
      title: "Bank reconciliation — all accounts",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: karan.id,
      dueOffset: 6, status: TaskStatus.ASSIGNED, priority: Priority.NORMAL,
      reviewerId: divya.id, estimate: hours(5),
    },
    // ── Awaiting review — the manager's own bottleneck ─────────────────────
    {
      title: "Related party transactions schedule",
      engagementId: meridianAudit.id, createdById: rohit.id, assigneeId: karan.id,
      dueOffset: 2, status: TaskStatus.REVIEW, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(4), actual: hours(6.5), startedDaysAgo: 6,
    },
    {
      title: "Fixed asset register verification",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: 8, status: TaskStatus.REVIEW, priority: Priority.LOW,
      reviewerId: rohit.id, estimate: hours(3), actual: hours(3.25), startedDaysAgo: 3,
    },
    // ── Rework: sent back once. This is the rework metric in action ────────
    {
      title: "Deferred tax working",
      engagementId: meridianAudit.id, createdById: rohit.id, assigneeId: anjali.id,
      dueOffset: 9, status: TaskStatus.IN_PROGRESS, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(4), actual: hours(7), startedDaysAgo: 10,
      reviewRound: 2,
      description: "Sent back: opening balances did not agree to last year's signed accounts.",
    },
    // ── Later ─────────────────────────────────────────────────────────────
    {
      title: "Draft internal audit scope for FY 2026-27",
      engagementId: meridianIa.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: 15, status: TaskStatus.ASSIGNED, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(6),
    },
    {
      title: "ROC filing — AOC-4",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: 22, externalDeadlineOffset:25, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.ASSIGNED, priority: Priority.NORMAL,
      reviewerId: rohit.id, estimate: hours(2),
    },
    {
      title: "Unestimated: review new GST notification impact",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: 12, status: TaskStatus.ASSIGNED, priority: Priority.LOW,
      reviewerId: kavya.id,
      // No estimate on purpose — the workload view must show how many tasks
      // it could not count rather than quietly presenting a confident number.
    },
    // ── Completed, with estimates wrong in both directions ────────────────
    {
      title: "GSTR-3B — June 2026",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: -36, externalDeadlineOffset:-36, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.COMPLETED, reviewerId: kavya.id,
      estimate: hours(3), actual: hours(2.5), startedDaysAgo: 40, completedDaysAgo: 37,
    },
    {
      title: "GSTR-1 — July 2026",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: -16, externalDeadlineOffset:-16, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.COMPLETED, reviewerId: kavya.id,
      estimate: hours(2.5), actual: hours(4), startedDaysAgo: 20, completedDaysAgo: 17,
    },
    {
      title: "Opening balance verification",
      engagementId: meridianAudit.id, createdById: rohit.id, assigneeId: karan.id,
      dueOffset: -10, status: TaskStatus.COMPLETED, reviewerId: rohit.id,
      estimate: hours(5), actual: hours(9), startedDaysAgo: 18, completedDaysAgo: 11,
      reviewRound: 3, tagIds: [firstYear.id],
    },
    {
      title: "Statutory dues verification",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: divya.id,
      dueOffset: -5, status: TaskStatus.COMPLETED, reviewerId: rohit.id,
      estimate: hours(3), actual: hours(3), startedDaysAgo: 9, completedDaysAgo: 6,
    },
    // ── Cancelled ─────────────────────────────────────────────────────────
    {
      title: "Physical verification at Rajkot branch",
      engagementId: orchidAudit.id, createdById: rohit.id, assigneeId: karan.id,
      dueOffset: -3, status: TaskStatus.CANCELLED, reviewerId: rohit.id,
      estimate: hours(8),
      cancelReason: "Branch closed during the year — confirmed with client CFO",
    },
    // ── Internal, non-client, no review ───────────────────────────────────
    {
      title: "Update firm's audit programme templates",
      engagementId: practiceAdmin.id, createdById: aarti.id, assigneeId: rohit.id,
      dueOffset: 20, status: TaskStatus.ASSIGNED, priority: Priority.LOW,
      reviewRequired: false, estimate: hours(4),
    },
    {
      title: "ICAI CPE — book December sessions",
      engagementId: practiceAdmin.id, createdById: aarti.id, assigneeId: anjali.id,
      dueOffset: 30, status: TaskStatus.ASSIGNED, priority: Priority.LOW,
      reviewRequired: false, estimate: hours(1),
    },
    // ── A parent with subtasks ────────────────────────────────────────────
    {
      title: "GST annual return — GSTR-9 & 9C FY 2025-26",
      engagementId: orchidGst.id, createdById: kavya.id, assigneeId: vikram.id,
      dueOffset: 40, externalDeadlineOffset:45, dueDateType: DueDateType.EXTERNAL_FIXED,
      status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH,
      reviewerId: kavya.id, estimate: hours(4), actual: hours(1), startedDaysAgo: 3,
      parentOf: [
        "Reconcile books turnover to GSTR-1",
        "Reconcile ITC to GSTR-2B",
        "Identify and quantify mismatches",
        "Prepare draft 9C reconciliation",
      ],
    },
  ];

  const created = new Map<string, bigint>();

  for (const s of specs) {
    const key = await nextTaskKey();
    const task = await db.task.create({
      data: {
        displayKey: key,
        title: s.title,
        description: s.description ?? null,
        engagementId: s.engagementId,
        createdById: s.createdById,
        assignedById: s.createdById,
        assigneeId: s.assigneeId,
        reviewerId: s.reviewerId ?? null,
        reviewRequired: s.reviewRequired ?? Boolean(s.reviewerId),
        status: s.status ?? TaskStatus.ASSIGNED,
        priority: s.priority ?? Priority.NORMAL,
        dueDate: day(s.dueOffset),
        dueDateType: s.dueDateType ?? DueDateType.INTERNAL,
        externalDeadline:
          s.externalDeadlineOffset === undefined ? null : day(s.externalDeadlineOffset),
        originalEstimateMinutes: s.estimate ?? null,
        currentEstimateMinutes: s.estimate ?? null,
        actualMinutes: s.actual ?? 0,
        isBlocked: Boolean(s.blockedReason),
        blockedReason: s.blockedReason ?? null,
        blockedSince: s.blockedReason ? hoursAgo(48) : null,
        expectedUnblockDate: s.blockedReason ? day(4) : null,
        startedAt: s.startedDaysAgo ? hoursAgo(s.startedDaysAgo * 24) : null,
        completedAt: s.completedDaysAgo ? hoursAgo(s.completedDaysAgo * 24) : null,
        cancelledAt: s.cancelReason ? hoursAgo(72) : null,
        cancelReason: s.cancelReason ?? null,
        reviewRound: s.reviewRound ?? 1,
        assignedAt: hoursAgo((s.startedDaysAgo ?? 1) * 24 + 12),
      },
    });

    created.set(s.title, task.id);

    for (const tagId of s.tagIds ?? []) {
      await db.taskTag.create({ data: { taskId: task.id, tagId } });
    }

    // Subtasks inherit engagement, assignee and reviewer from the parent.
    for (const [i, childTitle] of (s.parentOf ?? []).entries()) {
      const childKey = await nextTaskKey();
      await db.task.create({
        data: {
          displayKey: childKey,
          title: childTitle,
          engagementId: s.engagementId,
          parentTaskId: task.id,
          createdById: s.createdById,
          assignedById: s.createdById,
          assigneeId: s.assigneeId,
          reviewerId: s.reviewerId ?? null,
          reviewRequired: false,
          status: i === 0 ? TaskStatus.COMPLETED : TaskStatus.ASSIGNED,
          completedAt: i === 0 ? hoursAgo(20) : null,
          dueDate: day(s.dueOffset - (3 - i) * 5),
          currentEstimateMinutes: hours(2),
          originalEstimateMinutes: hours(2),
          actualMinutes: i === 0 ? hours(1.75) : 0,
        },
      });
    }
  }

  console.log(`  ${created.size} parent tasks created (plus subtasks)`);

  // ── Contributors ─────────────────────────────────────────────────────────
  // Karan helps Divya on the stock valuation; Anjali helps Vikram on GSTR-9.
  const stockTask = created.get("Verify closing stock valuation")!;
  const gstr9Task = created.get("GST annual return — GSTR-9 & 9C FY 2025-26")!;

  await db.taskContributor.create({
    data: { taskId: stockTask, userId: karan.id, addedById: rohit.id },
  });
  await db.taskContributor.create({
    data: { taskId: gstr9Task, userId: anjali.id, addedById: kavya.id },
  });

  // ── Time entries ─────────────────────────────────────────────────────────
  // Non-overlapping sessions per user per day, or the exclusion constraint
  // rejects them — which is the constraint doing its job.
  const logged: {
    taskTitle: string; userId: bigint; daysAgo: number; startHour: number; hoursWorked: number;
  }[] = [
    { taskTitle: "GSTR-3B — July 2026", userId: vikram.id, daysAgo: 8, startHour: 10, hoursWorked: 2 },
    { taskTitle: "GSTR-3B — July 2026", userId: vikram.id, daysAgo: 7, startHour: 14, hoursWorked: 1.5 },
    { taskTitle: "GSTR-3B — July 2026", userId: vikram.id, daysAgo: 2, startHour: 11, hoursWorked: 1 },
    { taskTitle: "TDS return 26Q — Q1 FY 2026-27", userId: anjali.id, daysAgo: 5, startHour: 9, hoursWorked: 3 },
    { taskTitle: "TDS return 26Q — Q1 FY 2026-27", userId: anjali.id, daysAgo: 4, startHour: 15, hoursWorked: 2.25 },
    { taskTitle: "Verify closing stock valuation", userId: divya.id, daysAgo: 4, startHour: 10, hoursWorked: 2 },
    { taskTitle: "Vouching of purchases — sample selection", userId: karan.id, daysAgo: 2, startHour: 9, hoursWorked: 3 },
    { taskTitle: "Related party transactions schedule", userId: karan.id, daysAgo: 6, startHour: 13, hoursWorked: 4 },
    { taskTitle: "Related party transactions schedule", userId: karan.id, daysAgo: 5, startHour: 10, hoursWorked: 2.5 },
    { taskTitle: "Deferred tax working", userId: anjali.id, daysAgo: 10, startHour: 10, hoursWorked: 4 },
    { taskTitle: "Deferred tax working", userId: anjali.id, daysAgo: 3, startHour: 11, hoursWorked: 3 },
    { taskTitle: "Advance tax computation — Q2", userId: anjali.id, daysAgo: 1, startHour: 15, hoursWorked: 1.5 },
    { taskTitle: "Fixed asset register verification", userId: divya.id, daysAgo: 3, startHour: 14, hoursWorked: 3.25 },
    { taskTitle: "Opening balance verification", userId: karan.id, daysAgo: 14, startHour: 9, hoursWorked: 5 },
    { taskTitle: "Opening balance verification", userId: karan.id, daysAgo: 12, startHour: 10, hoursWorked: 4 },
  ];

  for (const l of logged) {
    const taskId = created.get(l.taskTitle);
    if (!taskId) continue;

    const start = day(-l.daysAgo);
    start.setUTCHours(l.startHour - 5, 30, 0, 0); // IST → UTC
    const end = new Date(start.getTime() + l.hoursWorked * 3_600_000);

    await db.timeEntry.create({
      data: {
        taskId, userId: l.userId,
        workDate: day(-l.daysAgo),
        startedAt: start, endedAt: end,
        durationMinutes: hours(l.hoursWorked),
        source: TimeEntrySource.TIMER,
      },
    });
  }

  // A RUNNING timer, so the UI has a live one to render from the first run.
  await db.timeEntry.create({
    data: {
      taskId: created.get("Advance tax computation — Q2")!,
      userId: anjali.id,
      workDate: startOfToday(),
      startedAt: hoursAgo(1.5),
      source: TimeEntrySource.TIMER,
    },
  });

  // A manual entry with a note — the >8h guardrail requires one.
  await db.timeEntry.create({
    data: {
      taskId: created.get("Opening balance verification")!,
      userId: karan.id,
      workDate: day(-13),
      durationMinutes: hours(9),
      source: TimeEntrySource.MANUAL,
      note: "Full day at client premises reconstructing opening balances from ledgers",
    },
  });

  console.log(`  ${logged.length + 2} time entries created (one still running)`);

  // ── Comments ─────────────────────────────────────────────────────────────
  await db.comment.create({
    data: {
      taskId: created.get("GSTR-3B — July 2026")!,
      authorId: kavya.id,
      bodyMd: "@Vikram Gupta this is now past the due date. What is outstanding on the ITC side?",
      mentions: [vikram.id],
      createdAt: hoursAgo(30),
    },
  });
  await db.comment.create({
    data: {
      taskId: created.get("GSTR-3B — July 2026")!,
      authorId: vikram.id,
      bodyMd: "Two vendors have not uploaded their invoices. I have written to both; will follow up tomorrow.",
      createdAt: hoursAgo(26),
    },
  });
  await db.comment.create({
    data: {
      taskId: created.get("Deferred tax working")!,
      authorId: rohit.id,
      bodyMd: "Sending this back — the opening balances do not agree to last year's signed accounts. Please tie them out before resubmitting.",
      createdAt: hoursAgo(72),
    },
  });
  await db.comment.create({
    data: {
      taskId: created.get("Verify closing stock valuation")!,
      authorId: divya.id,
      bodyMd: "Blocked on the Surat warehouse sheets. @Rohit Desai can you chase the client contact?",
      mentions: [rohit.id],
      createdAt: hoursAgo(46),
    },
  });

  // ── Notifications ────────────────────────────────────────────────────────
  await db.notification.createMany({
    data: [
      { userId: vikram.id, type: NotificationType.MENTIONED, taskId: created.get("GSTR-3B — July 2026")!, payload: { by: "Kavya Iyer" }, createdAt: hoursAgo(30) },
      { userId: rohit.id, type: NotificationType.MENTIONED, taskId: created.get("Verify closing stock valuation")!, payload: { by: "Divya Menon" }, createdAt: hoursAgo(46) },
      { userId: kavya.id, type: NotificationType.REVIEW_REQUESTED, taskId: created.get("TDS return 26Q — Q1 FY 2026-27")!, payload: { by: "Anjali Nair" }, createdAt: hoursAgo(20) },
      { userId: anjali.id, type: NotificationType.REVIEW_REJECTED, taskId: created.get("Deferred tax working")!, payload: { by: "Rohit Desai" }, createdAt: hoursAgo(72), readAt: hoursAgo(70) },
    ],
  });

  // ── A little activity history ────────────────────────────────────────────
  await db.activityLog.createMany({
    data: [
      { taskId: created.get("Deferred tax working")!, actorId: rohit.id, action: ActivityAction.REVIEW_REJECTED, reason: "Opening balances do not agree to signed accounts", actedAt: hoursAgo(72) },
      { taskId: created.get("Verify closing stock valuation")!, actorId: divya.id, action: ActivityAction.BLOCKED, field: "isBlocked", oldValue: false, newValue: true, reason: "Awaiting stock count sheets", actedAt: hoursAgo(48) },
      { taskId: created.get("GSTR-3B — July 2026")!, actorId: kavya.id, action: ActivityAction.PRIORITY_CHANGED, field: "priority", oldValue: "HIGH", newValue: "CRITICAL", actedAt: hoursAgo(28) },
    ],
  });

  // ── Firm-wide saved views ────────────────────────────────────────────────
  // Preloaded because users who have to build their first view usually never
  // build one, and then never use filtering at all.
  await db.savedView.createMany({
    data: [
      { name: "My overdue", filters: { assignee: "me", overdue: true }, isSystem: true, sortOrder: 1 },
      { name: "Due this week", filters: { dueWithinDays: 7, status: ["ASSIGNED", "IN_PROGRESS", "REVIEW"] }, isSystem: true, sortOrder: 2 },
      { name: "Assigned by me", filters: { assignedBy: "me" }, isSystem: true, sortOrder: 3 },
      { name: "Awaiting my review", filters: { reviewer: "me", status: ["REVIEW"] }, isSystem: true, sortOrder: 4 },
      { name: "Blocked", filters: { blocked: true }, isSystem: true, sortOrder: 5 },
      { name: "Statutory, next 30 days", filters: { dueDateType: ["STATUTORY"], dueWithinDays: 30 }, isSystem: true, sortOrder: 6 },
      { name: "No estimate", filters: { hasEstimate: false, status: ["ASSIGNED", "IN_PROGRESS"] }, isSystem: true, sortOrder: 7 },
    ],
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  const [users, clients, engagements, tasks, entries, comments] = await Promise.all([
    db.user.count(), db.client.count(), db.engagement.count(),
    db.task.count(), db.timeEntry.count(), db.comment.count(),
  ]);

  console.log(`
  Seed complete
  ─────────────────────────────────────────
    ${users} users        ${clients} clients
    ${engagements} engagements  ${tasks} tasks
    ${entries} time entries ${comments} comments

  Sign in as (once dev auth is wired up):
    admin@demo.invalid          Admin
    partner.rao@demo.invalid    Partner
    manager.iyer@demo.invalid   Manager, Direct Tax
    manager.desai@demo.invalid  Manager, Audit
    exec.nair@demo.invalid      Senior  (has a running timer)
    exec.gupta@demo.invalid     Executive, GST (has overdue work)
    article.jain@demo.invalid   Article
  `);
}

main()
  .catch((e) => {
    console.error("\nSeed failed:\n", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
