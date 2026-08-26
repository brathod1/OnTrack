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

import { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CAP, isCapability, type Capability } from "./capabilities";

// ── The session shape the whole app works with ──────────────────────────────

export interface ActingUser {
  id: bigint;

  /**
   * What this user may do. THE basis of every permission decision.
   *
   * Note there is no `role` field used for decisions. `roleLabel` below is for
   * display only — if you ever find yourself comparing it, the answer you want
   * is a capability. That is the whole point of this model: another
   * organisation renames "Senior" to "Project Manager" and nothing breaks.
   */
  capabilities: ReadonlySet<Capability>;

  /** Display only. Never branch on these. */
  roleId: bigint;
  roleKey: string;
  roleLabel: string;

  teamId: bigint | null;
  /** Transitive closure of everyone below this user in the reporting line. */
  reportChainIds: bigint[];
  /** Engagements where this user has an active membership. */
  engagementIds: bigint[];
}

/**
 * Does this user hold a capability?
 *
 * ⚠ ON ITS OWN THIS IS NOT A PERMISSION CHECK.
 *
 *     CAPABILITY grants the ABILITY.  RELATIONSHIP grants the SCOPE.
 *
 * "May reassign tasks" is a capability; "…but only on engagements she manages,
 * or for her reports" is a relationship. Every function below checks both. A
 * check that consults only `can()` would let any manager reassign anyone's
 * work anywhere in the firm.
 */
export function can(user: ActingUser, capability: Capability): boolean {
  return user.capabilities.has(capability);
}

/**
 * Whether this user administers the organisation.
 *
 * Expressed as a capability rather than a role comparison, so an organisation
 * that splits administration across two roles gets the behaviour it configured
 * rather than the behaviour we assumed.
 */
function isOrgAdmin(user: ActingUser): boolean {
  return user.capabilities.has(CAP.MANAGE_ORGANIZATION);
}

// Defined in @/lib/errors, which imports nothing — so the HTTP layer can map
// errors to status codes without pulling in Prisma or Auth.js. Imported for
// use below AND re-exported, so existing callers are unaffected.
import { ForbiddenError, NotFoundError } from "@/lib/errors";

export {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidOperationError,
  assertPermitted,
} from "@/lib/errors";

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
      select: {
        id: true,
        teamId: true,
        status: true,
        role: { select: { id: true, key: true, label: true, capabilities: true } },
      },
    }),
    prisma.engagementMember.findMany({
      where: { userId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
      select: { engagementId: true },
    }),
    loadReportChain(userId),
  ]);

  // A deactivated user has no reach at all, even with a live session cookie.
  if (user.status !== "ACTIVE") throw new ForbiddenError("account is not active");

  // Unknown strings are dropped rather than trusted. A capability removed from
  // the code but still stored on a role would otherwise sit in the set forever,
  // silently granting something no check understands.
  const capabilities = new Set<Capability>(
    user.role.capabilities.filter(isCapability)
  );

  return {
    id: user.id,
    capabilities,
    roleId: user.role.id,
    roleKey: user.role.key,
    roleLabel: user.role.label,
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

  // The one capability that bypasses the relationship model entirely, which is
  // why it is granted sparingly and its use is auditable.
  if (can(user, CAP.VIEW_ALL_TASKS)) return notDeleted;

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

  // 7. Named as the partner or manager ON the engagement, or as the client's
  //    relationship partner — responsibility held without being listed as a
  //    working member.
  //
  //    NO CAPABILITY GATE HERE, deliberately. This branch previously required
  //    role PARTNER or MANAGER, which was wrong: being named on an engagement
  //    IS the relationship. Whoever the organisation put in that column can
  //    see the work, whatever their role is called.
  relationships.push({
    engagement: {
      OR: [
        { partnerId: user.id },
        { managerId: user.id },
        { client: { relationshipPartnerId: user.id } },
      ],
    },
  });

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
  // ABILITY: without this, nothing else matters — a Staff role holds no
  // task.assign, so the relationship checks below never run for them.
  if (!can(user, CAP.TASK_ASSIGN)) return false;

  if (isOrgAdmin(user)) return true;

  // SCOPE: one of these relationships must also hold.
  return (
    task.engagementPartnerId === user.id ||
    task.engagementManagerId === user.id ||
    user.reportChainIds.includes(task.assigneeId) ||
    user.engagementIds.includes(task.engagementId)
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
  | "dueDateType"
  | "externalDeadline"
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
    // Reassigning and naming a reviewer are the essence of directing work,
    // so `manages` (which already requires task.assign) is the whole test.
    case "assigneeId":
    case "reviewerId":
      return manages;

    // Separate capabilities, deliberately. An organisation may want a team
    // lead who distributes work without being able to renegotiate the
    // commitments attached to it — that is a role with task.assign but not
    // task.set_deadline, and it is now expressible.
    case "priority":
      return manages && can(user, CAP.TASK_SET_PRIORITY);

    case "dueDate":
      return manages && can(user, CAP.TASK_SET_DEADLINE);

    // Classifying work drives escalation and display. Cannot be used to escape
    // a deadline: the ceiling is enforced by the CHECK constraint on the
    // external date, not by this field.
    case "dueDateType":
      return manages && can(user, CAP.TASK_SET_DEADLINE);

    // A date the organisation does not control — a filing deadline, a
    // contractual SLA. Getting it wrong has consequences outside this system,
    // so it carries its own capability rather than riding on task.set_deadline.
    case "externalDeadline":
      return can(user, CAP.TASK_SET_EXTERNAL_DEADLINE);

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
  if (!can(user, CAP.TIME_LOG)) return false;

  return (
    task.assigneeId === user.id ||
    task.isContributor ||
    task.reviewerId === user.id ||
    isOrgAdmin(user)
  );
}

/**
 * Editing somebody else's time entry. Always allowed to be visible, never
 * silent: the caller must supply a reason, and the edit is attributed in the
 * activity log with the old and new values.
 */
export function canEditOthersTime(user: ActingUser, entryOwnerId: bigint): boolean {
  // Your own entries need no capability — correcting your own timesheet is
  // not a privilege.
  if (entryOwnerId === user.id) return true;

  if (!can(user, CAP.TIME_EDIT_OTHERS)) return false;
  if (isOrgAdmin(user)) return true;

  return user.reportChainIds.includes(entryOwnerId);
}

/**
 * Whether a user may create a task on a given engagement.
 *
 * Creation has no task to authorise against, so it needs its own rule. It is
 * deliberately more permissive than `canManageTask`: a member noting down work
 * they have discovered is normal and useful, whereas re-planning someone
 * else's deadline is not. Teams that want it locked down set
 * `membersCanCreateTasks: false` — Practice Administration does, so nobody
 * invents their own admin tasks.
 */
export interface EngagementCreateContext {
  engagementId: bigint;
  partnerId: bigint | null;
  managerId: bigint | null;
  /** From the engagement's team. Null team = allowed. */
  membersCanCreateTasks: boolean;
  /** CLOSED engagements accept no new work. */
  isActive: boolean;
}

export function canCreateTask(user: ActingUser, eng: EngagementCreateContext): boolean {
  if (!eng.isActive) return false;
  if (!can(user, CAP.TASK_CREATE)) return false;

  if (isOrgAdmin(user)) return true;
  if (eng.partnerId === user.id || eng.managerId === user.id) return true;

  if (!user.engagementIds.includes(eng.engagementId)) return false;

  // Someone who can direct work can always record it. The team's
  // members-can-create switch is about people who only do the work.
  if (can(user, CAP.TASK_ASSIGN)) return true;
  return eng.membersCanCreateTasks;
}

// ── Cross-cutting helpers ───────────────────────────────────────────────────

/** Scope for the "Team Tasks" view: everyone this user is entitled to oversee. */
export function overseeableUserIds(user: ActingUser): bigint[] | "ALL" {
  if (can(user, CAP.VIEW_ALL_TASKS)) return "ALL";
  return [user.id, ...user.reportChainIds];
}

/**
 * Gate for the "All tasks" screen.
 *
 * ⚠ A SCREEN gate, not a scope grant. Whatever this screen renders is still
 * passed through `visibleTaskFilter` — a partner sees their own clients across
 * every engagement, an administrator sees everything. The two are different
 * capabilities precisely because conflating them once already leaked every
 * partner's portfolio to every other partner.
 */
export function canViewAllTasks(user: ActingUser): boolean {
  return can(user, CAP.VIEW_ALL_TASKS) || can(user, CAP.VIEW_PORTFOLIO);
}

/** Gate for the Team view in navigation. */
export function canOverseeOthers(user: ActingUser): boolean {
  return (
    can(user, CAP.TASK_ASSIGN) ||
    can(user, CAP.VIEW_REPORTS) ||
    can(user, CAP.VIEW_ALL_TASKS)
  );
}

