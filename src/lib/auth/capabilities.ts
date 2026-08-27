/**
 * The capability catalogue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A capability is a thing a person may DO. A role is a named set of them.
 * Roles are rows an administrator can rename and re-scope; capabilities are
 * constants, because each one exists precisely where the code checks it.
 *
 * WHY THESE ARE CODE, NOT DATA: a capability nobody checks does nothing, and
 * a check with no capability behind it cannot be configured. The two must
 * stay in step, so they live in the same repository. What is genuinely
 * configurable is which capabilities each role holds — that is data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTANT — capability is only half of a permission decision.
 *
 *     CAPABILITY grants the ABILITY.  RELATIONSHIP grants the SCOPE.
 *
 * "May reassign tasks" is a capability. "…but only on engagements she manages,
 * or for people who report to her" is a relationship. Checking capability
 * alone would let any manager reassign anyone's work anywhere in the firm.
 *
 * Every function in permissions.ts therefore checks BOTH. If you ever find a
 * check that consults only `can()`, it is almost certainly a bug.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const CAP = {
  // ── Work ────────────────────────────────────────────────────────────────
  /** Create a task on an engagement you belong to. */
  TASK_CREATE: "task.create",
  /** Put work on someone else's plate, and move it between people. */
  TASK_ASSIGN: "task.assign",
  /** Move a due date. Deliberately separate from assigning: a team lead may
   *  distribute work without being able to renegotiate commitments. */
  TASK_SET_DEADLINE: "task.set_deadline",
  /** Set a deadline the organisation does not control — a statutory filing
   *  date, a contractual SLA. Narrower than TASK_SET_DEADLINE because getting
   *  it wrong has consequences outside the system. */
  TASK_SET_EXTERNAL_DEADLINE: "task.set_external_deadline",
  TASK_SET_PRIORITY: "task.set_priority",
  TASK_CANCEL: "task.cancel",
  /** Reopen completed work. Separate from cancel: undoing a completion
   *  rewrites a record someone already relied on. */
  TASK_REOPEN: "task.reopen",
  /** Approve or send back work submitted for review. */
  TASK_REVIEW: "task.review",

  // ── Time ────────────────────────────────────────────────────────────────
  TIME_LOG: "time.log",
  /** Edit or delete someone else's time entry. Always attributed and logged;
   *  scope is still restricted to people you oversee. */
  TIME_EDIT_OTHERS: "time.edit_others",

  // ── Visibility ──────────────────────────────────────────────────────────
  /**
   * Unrestricted access to every task, bypassing the relationship model
   * entirely.
   *
   * ⚠ THE MOST DANGEROUS CAPABILITY IN THE SYSTEM. Administrators only.
   *
   * It was briefly granted to Partner during the capability refactor, on the
   * assumption that it meant "may open the All Tasks screen". It does not — it
   * means "relationship checks do not apply to you", and every partner
   * immediately gained access to every other partner's client portfolio. The
   * permission suite caught it; nothing else would have.
   *
   * If you want someone to browse widely WITHIN their relationships, that is
   * VIEW_PORTFOLIO below.
   */
  VIEW_ALL_TASKS: "view.all_tasks",

  /**
   * May use the cross-engagement browse and portfolio screens.
   *
   * A SCREEN gate, not a scope grant. Everything shown is still filtered by
   * `visibleTaskFilter`, so a partner sees their own clients across every
   * engagement — and nobody else's. This is what "All tasks" means for anyone
   * who is not an administrator.
   */
  VIEW_PORTFOLIO: "view.portfolio",
  VIEW_REPORTS: "view.reports",
  /** Read the activity log beyond a single task's own timeline. */
  VIEW_AUDIT_LOG: "view.audit_log",

  // ── Administration ──────────────────────────────────────────────────────
  MANAGE_USERS: "manage.users",
  /** Clients, engagements, teams. */
  MANAGE_WORK_AREAS: "manage.work_areas",
  /** Organisation settings, roles, terminology, statuses. */
  MANAGE_ORGANIZATION: "manage.organization",
} as const;

export type Capability = (typeof CAP)[keyof typeof CAP];

export const ALL_CAPABILITIES: Capability[] = Object.values(CAP);

/**
 * Capabilities an administrator must always retain.
 *
 * Without this, an administrator can remove `manage.organization` from their
 * own role and lock every human out of the installation permanently — a
 * support call that can only be resolved with database access.
 */
export const PROTECTED_ADMIN_CAPABILITIES: Capability[] = [
  CAP.MANAGE_ORGANIZATION,
  CAP.MANAGE_USERS,
];

/**
 * The default roles a new organisation starts with.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SEED DATA, NOT BEHAVIOUR. These labels suit a professional services firm
 * because that is the first organisation using OnTrack. Another organisation
 * renames "Senior" to "Project Manager", or deletes it and builds its own —
 * no code changes, because nothing in the engine looks up a role by name.
 *
 * `key` is the stable identifier used by seeds and migrations and is never
 * shown to a user. `label` is what people see and is freely editable.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface RoleTemplate {
  key: string;
  label: string;
  description: string;
  capabilities: Capability[];
  isSystem: boolean;
  sortOrder: number;
}

export const DEFAULT_ROLES: RoleTemplate[] = [
  {
    key: "admin",
    label: "Administrator",
    description: "Full access, including users, work areas and configuration.",
    capabilities: ALL_CAPABILITIES,
    // Cannot be deleted or stripped of PROTECTED_ADMIN_CAPABILITIES.
    isSystem: true,
    sortOrder: 1,
  },
  {
    key: "partner",
    label: "Partner",
    description:
      "Oversees clients and engagements. Sees all work, directs it, and reviews.",
    capabilities: [
      CAP.TASK_CREATE, CAP.TASK_ASSIGN, CAP.TASK_SET_DEADLINE,
      CAP.TASK_SET_PRIORITY, CAP.TASK_CANCEL, CAP.TASK_REOPEN, CAP.TASK_REVIEW,
      CAP.TIME_LOG, CAP.TIME_EDIT_OTHERS,
      // VIEW_PORTFOLIO, not VIEW_ALL_TASKS. A partner browses widely across
      // their OWN clients; the relationship filter still applies. Granting
      // VIEW_ALL_TASKS here would let every partner read every other
      // partner's engagements.
      CAP.VIEW_PORTFOLIO, CAP.VIEW_REPORTS, CAP.VIEW_AUDIT_LOG,
      CAP.MANAGE_WORK_AREAS,
    ],
    isSystem: false,
    sortOrder: 2,
  },
  {
    key: "senior",
    label: "Senior",
    description:
      "Runs engagements and a team. Assigns work, moves deadlines, reviews.",
    capabilities: [
      CAP.TASK_CREATE, CAP.TASK_ASSIGN, CAP.TASK_SET_DEADLINE,
      CAP.TASK_SET_PRIORITY, CAP.TASK_CANCEL, CAP.TASK_REOPEN, CAP.TASK_REVIEW,
      CAP.TIME_LOG, CAP.TIME_EDIT_OTHERS,
      // Added in Stage 14. A manager already sees every task they oversee on
      // the Team dashboard; without this they could see that list and not
      // search it. VIEW_PORTFOLIO is a SCREEN gate and grants no scope —
      // visibleTaskFilter still decides what comes back — so this widens what
      // a manager can DO with their work, not what work they can reach.
      CAP.VIEW_PORTFOLIO,
      CAP.VIEW_REPORTS,
    ],
    isSystem: false,
    sortOrder: 3,
  },
  {
    key: "staff",
    label: "Staff",
    description:
      "Does the work. Updates their own tasks, logs time, comments.",
    capabilities: [
      // Note what is ABSENT: no deadline, no priority, no assign. A member
      // who could move their own due date makes deadlines meaningless — they
      // request a change instead, which notifies a manager and is logged.
      CAP.TASK_CREATE,
      CAP.TIME_LOG,
    ],
    isSystem: false,
    sortOrder: 4,
  },
];

/** Guard for values arriving from the database or a form. */
export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as string[]).includes(value);
}
