/**
 * OnTrack — the authorisation kernel.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE RULE: every query that returns tasks composes `visibleTaskFilter`,
 * and every fetch-by-id runs `assertCanReadTask` after loading. There is no
 * authorisation logic anywhere else in the codebase — not in route handlers,
 * and never in React components. UI hiding is cosmetic.
 *
 * A denied read returns 404, not 403. A 403 confirms the record exists, which
 * is exactly the information a user probing task IDs is trying to obtain.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { Prisma, Role, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

// ── The session shape the whole app works with ──────────────────────────────

export interface ActingUser {
  id: bigint;
  role: Role;
  teamId: bigint | null;
  /** Transitive closure of everyone below this user in the reporting line. */
  reportChainIds: bigint[];
  /** Engagements where this user has an active membership. */
  engagementIds: bigint[];
}

export class NotFoundError extends Error {
  constructor(what = "Resource") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(action: string) {
    super(`Not permitted: ${action}`);
    this.name = "ForbiddenError";
  }
}

// ── Loading the acting user ─────────────────────────────────────────────────

/**
 * Transitive report chain, computed in the database with a recursive CTE.
 *
 * Doing this in application code means N queries for a partner with a deep
 * org beneath them. The `depth < 10` guard is a cycle brake: reporting lines
 * should never loop, but a bad admin edit must not hang every request.
 */
export async function loadReportChain(userId: bigint): Promise<bigint[]> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    WITH RECURSIVE chain AS (
      SELECT id, 1 AS depth FROM users WHERE reports_to_id = ${userId}
      UNION ALL
      SELECT u.id, c.depth + 1
        FROM users u
        JOIN chain c ON u.reports_to_id = c.id
       WHERE c.depth < 10
    )
    SELECT DISTINCT id FROM chain
  `;
  return rows.map((r) => r.id);
}

export async function loadActingUser(userId: bigint): Promise<ActingUser> {
  const [user, memberships, reportChainIds] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, role: true, teamId: true, status: true },
    }),
    prisma.engagementMember.findMany({
      where: { userId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
      select: { engagementId: true },
    }),
    loadReportChain(userId),
  ]);

  // A deactivated user has no reach at all, even with a live session cookie.
  if (user.status !== "ACTIVE") throw new ForbiddenError("account is not active");

  return {
    id: user.id,
    role: user.role,
    teamId: user.teamId,
    reportChainIds,
    engagementIds: memberships.map((m) => m.engagementId),
  };
}

// ── Visibility ──────────────────────────────────────────────────────────────

/**
 * The single source of truth for "which tasks may this user see".
 *
 * Build Spec §4 — visibility is relationship-based, not a hierarchy walk,
 * because a person routinely works on engagements whose manager is not their
 * line manager. Any one of these relationships grants read access.
 *
 * Compose it into every list query:
 *     prisma.task.findMany({ where: { AND: [visibleTaskFilter(me), ...filters] } })
 */
export function visibleTaskFilter(user: ActingUser): Prisma.TaskWhereInput {
  const notDeleted: Prisma.TaskWhereInput = { deletedAt: null };

  // Admin sees everything. This is the only unconditional grant in the system,
  // and it is audited like every other read of an attachment or export.
  if (user.role === Role.ADMIN) return notDeleted;

  const relationships: Prisma.TaskWhereInput[] = [
    { assigneeId: user.id }, // 1. assignee
    { contributors: { some: { userId: user.id } } }, // 2. contributor
    { reviewerId: user.id }, // 3. reviewer
    { createdById: user.id }, // 4. creator
    { assignedById: user.id }, //    ...or assigner
  ];

  // 5. Active member of the task's engagement.
  if (user.engagementIds.length > 0) {
    relationships.push({ engagementId: { in: user.engagementIds } });
  }

  // 6. Line-manages the assignee, transitively.
  if (user.reportChainIds.length > 0) {
    relationships.push({ assigneeId: { in: user.reportChainIds } });
    relationships.push({ contributors: { some: { userId: { in: user.reportChainIds } } } });
  }

  // 7. Partner or manager named on the engagement — covers engagements where
  //    they hold responsibility without being listed as a working member.
  if (user.role === Role.PARTNER || user.role === Role.MANAGER) {
    relationships.push({
      engagement: {
        OR: [{ partnerId: user.id }, { managerId: user.id }, { client: { relationshipPartnerId: user.id } }],
      },
    });
  }

  return { AND: [notDeleted, { OR: relationships }] };
}

/**
 * Row check for fetch-by-id. Throws NotFoundError — never ForbiddenError —
 * so a probing user cannot distinguish "exists but forbidden" from "absent".
 */
export async function assertCanReadTask(user: ActingUser, taskId: bigint): Promise<void> {
  const visible = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, visibleTaskFilter(user)] },
    select: { id: true },
  });
  if (!visible) throw new NotFoundError("Task");
}

// ── Write permissions ───────────────────────────────────────────────────────

/** The fields a request is trying to change, resolved against the actor. */
export interface TaskWriteContext {
  assigneeId: bigint;
  createdById: bigint;
  assignedById: bigint | null;
  reviewerId: bigint | null;
  engagementId: bigint;
  status: TaskStatus;
  isContributor: boolean;
  /** Engagement partner/manager ids, for the "responsible for this work" test. */
  engagementPartnerId: bigint | null;
  engagementManagerId: bigint | null;
}

/**
 * "Can this user direct the work" — assign, reassign, move deadlines, change
 * priority, cancel, reopen. Deliberately narrower than read access: being on
 * an engagement lets you see the work, not re-plan someone else's.
 */
export function canManageTask(user: ActingUser, task: TaskWriteContext): boolean {
  if (user.role === Role.ADMIN) return true;
  if (user.role === Role.MEMBER) return false;

  return (
    task.engagementPartnerId === user.id ||
    task.engagementManagerId === user.id ||
    user.reportChainIds.includes(task.assigneeId) ||
    // A manager who is an active member of the engagement can direct its work.
    (user.role === Role.MANAGER && user.engagementIds.includes(task.engagementId))
  );
}

/**
 * Field-level write rules. Called for every field in a PATCH before anything
 * is written — a partial update must not half-apply.
 *
 * Note what a MEMBER cannot change: their own due date and priority. If they
 * could, deadlines would mean nothing. They request a change instead, which
 * notifies the manager and is logged.
 */
export type WritableField =
  | "title"
  | "description"
  | "status"
  | "priority"
  | "dueDate"
  | "statutoryDueDate"
  | "assigneeId"
  | "reviewerId"
  | "currentEstimateMinutes"
  | "isBlocked"
  | "tags"
  | "contributors";

export function canWriteField(
  user: ActingUser,
  task: TaskWriteContext,
  field: WritableField
): boolean {
  const manages = canManageTask(user, task);
  const isAssignee = task.assigneeId === user.id;

  switch (field) {
    // Manager-only: these define the commitment.
    case "priority":
    case "dueDate":
    case "assigneeId":
    case "reviewerId":
      return manages;

    // A statutory date is a matter of law, not of management discretion.
    case "statutoryDueDate":
      return user.role === Role.ADMIN;

    case "title":
    case "description":
    case "tags":
      return manages || isAssignee;

    // The assignee owns the state of their own work; managers can intervene.
    case "status":
    case "isBlocked":
      return manages || isAssignee || task.reviewerId === user.id;

    case "contributors":
      return manages || isAssignee;

    // Estimates: a manager any time; the assignee only before work has begun.
    // After the first time entry the original estimate is frozen anyway — the
    // Estimated-vs-Actual report is worthless if the target moves mid-flight.
    case "currentEstimateMinutes":
      return manages || (isAssignee && task.status === TaskStatus.ASSIGNED);

    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

/**
 * Who may log time against a task: the accountable owner, anyone explicitly
 * added as a contributor, and the reviewer (review time is real effort and is
 * otherwise invisible). Build Spec §3.
 *
 * Note this is NOT "anyone on the engagement" — untracked people logging hours
 * against work they don't own is how effort data becomes unattributable.
 */
export function canLogTime(user: ActingUser, task: TaskWriteContext): boolean {
  if (task.status === TaskStatus.CANCELLED) return false;
  return (
    task.assigneeId === user.id ||
    task.isContributor ||
    task.reviewerId === user.id ||
    user.role === Role.ADMIN
  );
}

/**
 * Editing somebody else's time entry. Always allowed to be visible, never
 * silent: the caller must supply a reason, and the edit is attributed in the
 * activity log with the old and new values.
 */
export function canEditOthersTime(user: ActingUser, entryOwnerId: bigint): boolean {
  if (entryOwnerId === user.id) return true;
  if (user.role === Role.ADMIN) return true;
  return (
    (user.role === Role.MANAGER || user.role === Role.PARTNER) &&
    user.reportChainIds.includes(entryOwnerId)
  );
}

// ── Cross-cutting helpers ───────────────────────────────────────────────────

/** Scope for the "Team Tasks" view: everyone this user is entitled to oversee. */
export function overseeableUserIds(user: ActingUser): bigint[] | "ALL" {
  if (user.role === Role.ADMIN) return "ALL";
  return [user.id, ...user.reportChainIds];
}

/** Gate for the "All Tasks" view and firm-wide reports. */
export function canViewAllTasks(user: ActingUser): boolean {
  return user.role === Role.ADMIN || user.role === Role.PARTNER;
}

export function assertPermitted(condition: boolean, action: string): asserts condition {
  if (!condition) throw new ForbiddenError(action);
}
