/**
 * OnTrack — the task status machine.
 *
 * Assigned → In Progress → Review → Completed, plus Cancelled.
 * "Reopened" is a transition (Completed → In Progress), not a status: a
 * reopened task sits in a real workflow position, and making it a state would
 * force every view and report to special-case it. Same reasoning as Blocked
 * being a flag.
 *
 * Every status change in the application goes through `resolveTransition`.
 * There is no code path that writes `task.status` directly.
 */

import { Role, TaskStatus } from "@prisma/client";
import type { ActingUser, TaskWriteContext } from "@/lib/auth/permissions";
import { canManageTask } from "@/lib/auth/permissions";

export type TransitionActor = "ASSIGNEE" | "REVIEWER" | "MANAGER";

export interface TransitionRule {
  from: TaskStatus;
  to: TaskStatus;
  /** Any one of these relationships permits the move. */
  allowedActors: TransitionActor[];
  requiresReason: boolean;
  /** Human-readable label for the button in the UI. */
  label: string;
  /** Extra checks beyond actor and reason. */
  guards?: Array<"REVIEWER_SET" | "NO_OPEN_SUBTASKS" | "HAS_TIME_LOGGED" | "REVIEW_REQUIRED" | "REVIEW_NOT_REQUIRED">;
}

export const TRANSITIONS: TransitionRule[] = [
  {
    from: TaskStatus.ASSIGNED,
    to: TaskStatus.IN_PROGRESS,
    allowedActors: ["ASSIGNEE", "MANAGER"],
    requiresReason: false,
    label: "Start work",
  },
  {
    // Review path.
    from: TaskStatus.IN_PROGRESS,
    to: TaskStatus.REVIEW,
    allowedActors: ["ASSIGNEE", "MANAGER"],
    requiresReason: false,
    label: "Submit for review",
    guards: ["REVIEWER_SET", "NO_OPEN_SUBTASKS", "HAS_TIME_LOGGED", "REVIEW_REQUIRED"],
  },
  {
    // No-review path — internal admin work shouldn't manufacture a queue.
    from: TaskStatus.IN_PROGRESS,
    to: TaskStatus.COMPLETED,
    allowedActors: ["ASSIGNEE", "MANAGER"],
    requiresReason: false,
    label: "Mark complete",
    guards: ["NO_OPEN_SUBTASKS", "HAS_TIME_LOGGED", "REVIEW_NOT_REQUIRED"],
  },
  {
    from: TaskStatus.REVIEW,
    to: TaskStatus.COMPLETED,
    allowedActors: ["REVIEWER", "MANAGER"],
    requiresReason: false,
    label: "Approve",
    guards: ["NO_OPEN_SUBTASKS"],
  },
  {
    // Rejection increments reviewRound — this is the rework metric, and it is
    // far more honest than any quality score somebody has to fill in.
    from: TaskStatus.REVIEW,
    to: TaskStatus.IN_PROGRESS,
    allowedActors: ["REVIEWER", "MANAGER"],
    requiresReason: true,
    label: "Send back",
  },
  {
    from: TaskStatus.COMPLETED,
    to: TaskStatus.IN_PROGRESS,
    allowedActors: ["MANAGER"],
    requiresReason: true,
    label: "Reopen",
  },
  { from: TaskStatus.ASSIGNED, to: TaskStatus.CANCELLED, allowedActors: ["MANAGER"], requiresReason: true, label: "Cancel" },
  { from: TaskStatus.IN_PROGRESS, to: TaskStatus.CANCELLED, allowedActors: ["MANAGER"], requiresReason: true, label: "Cancel" },
  { from: TaskStatus.REVIEW, to: TaskStatus.CANCELLED, allowedActors: ["MANAGER"], requiresReason: true, label: "Cancel" },
  {
    // Undo an accidental cancellation. Manager only, reason required.
    from: TaskStatus.CANCELLED,
    to: TaskStatus.ASSIGNED,
    allowedActors: ["MANAGER"],
    requiresReason: true,
    label: "Restore",
  },
];

export interface TransitionRequest {
  to: TaskStatus;
  reason?: string;
}

export interface TransitionFacts {
  openSubtaskCount: number;
  hasTimeLogged: boolean;
  reviewRequired: boolean;
  reviewerId: bigint | null;
  /** Manager+ may push past NO_OPEN_SUBTASKS and HAS_TIME_LOGGED with a reason. */
  overrideGuards?: boolean;
}

export type TransitionResult =
  | { ok: true; rule: TransitionRule; warnings: string[] }
  | { ok: false; error: string };

/**
 * The single gate. Returns the rule to apply plus any soft warnings the UI
 * should surface, or a refusal with a message a user can act on.
 */
export function resolveTransition(
  user: ActingUser,
  task: TaskWriteContext,
  facts: TransitionFacts,
  request: TransitionRequest
): TransitionResult {
  if (request.to === task.status) {
    return { ok: false, error: `Task is already ${label(task.status)}.` };
  }

  const rule = TRANSITIONS.find((t) => t.from === task.status && t.to === request.to);
  if (!rule) {
    return {
      ok: false,
      error: `Cannot move a task from ${label(task.status)} to ${label(request.to)}.`,
    };
  }

  // ── Actor ────────────────────────────────────────────────────────────────
  const actors: TransitionActor[] = [];
  if (task.assigneeId === user.id) actors.push("ASSIGNEE");
  if (task.reviewerId === user.id) actors.push("REVIEWER");
  if (canManageTask(user, task)) actors.push("MANAGER");

  if (!actors.some((a) => rule.allowedActors.includes(a))) {
    return { ok: false, error: `You are not permitted to ${rule.label.toLowerCase()} on this task.` };
  }

  // ── Reason ───────────────────────────────────────────────────────────────
  // Reasons are mandatory precisely where somebody will later ask "why did
  // this happen?" — rejections, reopens, cancellations.
  if (rule.requiresReason && !request.reason?.trim()) {
    return { ok: false, error: `A reason is required to ${rule.label.toLowerCase()} this task.` };
  }

  // ── Guards ───────────────────────────────────────────────────────────────
  const warnings: string[] = [];
  const canOverride = facts.overrideGuards === true && canManageTask(user, task);

  for (const guard of rule.guards ?? []) {
    switch (guard) {
      case "REVIEW_REQUIRED":
        if (!facts.reviewRequired) {
          return { ok: false, error: "This task does not require review — mark it complete instead." };
        }
        break;

      case "REVIEW_NOT_REQUIRED":
        if (facts.reviewRequired) {
          return { ok: false, error: "This task requires review — submit it for review instead." };
        }
        break;

      case "REVIEWER_SET":
        if (!facts.reviewerId) {
          return { ok: false, error: "Assign a reviewer before submitting for review." };
        }
        break;

      case "NO_OPEN_SUBTASKS":
        // Hard block by default. Parent status is never auto-derived from
        // children, and a parent closing over open subtasks is almost always
        // an error — but a manager who knows better can override with a reason.
        if (facts.openSubtaskCount > 0) {
          if (!canOverride) {
            return {
              ok: false,
              error: `${facts.openSubtaskCount} subtask(s) are still open. Close them first, or ask a manager to override.`,
            };
          }
          if (!request.reason?.trim()) {
            return { ok: false, error: "Overriding open subtasks requires a reason." };
          }
          warnings.push(`Closed with ${facts.openSubtaskCount} open subtask(s).`);
        }
        break;

      case "HAS_TIME_LOGGED":
        // Soft: completing with zero hours is usually a data-quality problem,
        // occasionally legitimate. Warn, allow, and report on it — blocking
        // would just teach people to log a fake 15 minutes.
        if (!facts.hasTimeLogged) {
          warnings.push("No time has been logged against this task.");
        }
        break;
    }
  }

  return { ok: true, rule, warnings };
}

/** Transitions to offer in the UI. Buttons the user cannot use aren't shown. */
export function availableTransitions(
  user: ActingUser,
  task: TaskWriteContext,
  facts: TransitionFacts
): TransitionRule[] {
  return TRANSITIONS.filter((rule) => {
    if (rule.from !== task.status) return false;
    const result = resolveTransition(user, task, facts, { to: rule.to, reason: "probe" });
    return result.ok;
  });
}

/**
 * Field changes that accompany a transition. Kept here so the side effects of
 * a status change live next to the rule that permits it, rather than being
 * scattered through the route handler.
 */
export function transitionSideEffects(
  rule: TransitionRule,
  now: Date
): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: rule.to };

  if (rule.to === TaskStatus.IN_PROGRESS && rule.from === TaskStatus.ASSIGNED) {
    patch.startedAt = now; // set once; the service layer skips if already set
  }
  if (rule.to === TaskStatus.COMPLETED) {
    patch.completedAt = now;
    patch.isBlocked = false;
    patch.blockedReason = null;
    patch.blockedSince = null;
  }
  if (rule.to === TaskStatus.CANCELLED) {
    patch.cancelledAt = now;
    patch.isBlocked = false;
  }
  if (rule.from === TaskStatus.REVIEW && rule.to === TaskStatus.IN_PROGRESS) {
    patch.reviewRound = { increment: 1 };
  }
  if (rule.from === TaskStatus.COMPLETED && rule.to === TaskStatus.IN_PROGRESS) {
    patch.reopenCount = { increment: 1 };
    patch.completedAt = null;
  }
  if (rule.from === TaskStatus.CANCELLED) {
    patch.cancelledAt = null;
    patch.cancelReason = null;
  }

  return patch;
}

export function label(status: TaskStatus): string {
  return {
    [TaskStatus.ASSIGNED]: "Assigned",
    [TaskStatus.IN_PROGRESS]: "In Progress",
    [TaskStatus.REVIEW]: "In Review",
    [TaskStatus.COMPLETED]: "Completed",
    [TaskStatus.CANCELLED]: "Cancelled",
  }[status];
}

/** Statuses that represent live work — used by every dashboard and workload sum. */
export const OPEN_STATUSES: TaskStatus[] = [
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.REVIEW,
];

/** Roles that can hold the MANAGER actor position. Convenience for the UI. */
export const MANAGING_ROLES: Role[] = [Role.ADMIN, Role.PARTNER, Role.MANAGER];
