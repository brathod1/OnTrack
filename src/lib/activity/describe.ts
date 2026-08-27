import type { ActivityAction, Prisma, Priority, TaskStatus } from "@prisma/client";
import { label as statusLabel } from "@/lib/tasks/transitions";

/**
 * Turning an activity row into a sentence a person can read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * This is where the activity log earns its keep. Stored, it is
 *
 *     DUE_DATE_CHANGED · due_date · "2026-09-30" → "2026-10-31" · "client
 *     extension agreed"
 *
 * which is a row in a table nobody opens. Rendered, it is
 *
 *     Kavya Iyer moved the due date from 30 Sep to 31 Oct — "client
 *     extension agreed"
 *
 * That difference is the entire reason the log is written inside every
 * transaction and the reason `reason` is mandatory on deadline changes,
 * reopens, cancellations and review rejections. Six months later, in front of
 * a client, "who moved that deadline?" stops being a conversation.
 *
 * Deliberately NOT stored as prose at write time. Storing "Kavya moved the
 * due date" would freeze one phrasing, in one language, and lose the
 * structured before/after that reports and audits need.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type ActivityTone = "neutral" | "notable" | "warning" | "positive";

export interface DescribedActivity {
  /** "moved the due date", "sent it back". Actor's name is rendered separately. */
  verb: string;
  /** "from 30 Sep to 31 Oct". Absent when the verb says everything. */
  detail?: string;
  tone: ActivityTone;
}

/** Resolves the user ids that appear inside old/new values. */
export type NameLookup = (id: string) => string;

const PRIORITY_LABELS: Record<Priority, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  NORMAL: "Normal",
  LOW: "Low",
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function minutes(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Render a stored JSON value according to which field it came from. */
function value(
  raw: Prisma.JsonValue | null,
  field: string | null,
  names: NameLookup
): string {
  if (raw === null || raw === undefined) return "nothing";

  if (typeof raw === "boolean") return raw ? "yes" : "no";

  if (typeof raw === "number") {
    return field?.toLowerCase().includes("minutes") ? minutes(raw) : String(raw);
  }

  if (typeof raw === "string") {
    // Ids arrive as strings because BigInt does not survive JSON.
    if (field && /Id$|^contributors$/.test(field)) return names(raw);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return shortDate(raw);
    if (field === "status") return statusLabel(raw as TaskStatus);
    if (field === "priority") return PRIORITY_LABELS[raw as Priority] ?? raw;
    return raw;
  }

  if (typeof raw === "object") {
    // Composite payloads — the creation snapshot, an auto-membership record.
    const obj = raw as Record<string, unknown>;
    if (typeof obj.userId === "string" || typeof obj.userId === "number") {
      return names(String(obj.userId));
    }
    if (typeof obj.minutes === "number") return minutes(obj.minutes);
    return "";
  }

  return String(raw);
}

export function describeActivity(
  entry: {
    action: ActivityAction;
    field: string | null;
    oldValue: Prisma.JsonValue | null;
    newValue: Prisma.JsonValue | null;
  },
  names: NameLookup
): DescribedActivity {
  const from = value(entry.oldValue, entry.field, names);
  const to = value(entry.newValue, entry.field, names);
  const change = `from ${from} to ${to}`;

  switch (entry.action) {
    case "TASK_CREATED":
      return { verb: "created this task", tone: "neutral" };

    case "TASK_ASSIGNED":
      return { verb: "assigned it to", detail: to, tone: "neutral" };

    case "TASK_REASSIGNED":
      return { verb: "reassigned it", detail: change, tone: "notable" };

    case "STATUS_CHANGED":
      return { verb: "moved it", detail: change, tone: "neutral" };

    case "SUBMITTED_FOR_REVIEW":
      return { verb: "submitted it for review", tone: "neutral" };

    case "REVIEW_APPROVED":
      return { verb: "approved it", tone: "positive" };

    case "REVIEW_REJECTED":
      // The rework signal. Called out because it is the honest quality
      // measure and because the person who did the work needs to see why.
      return { verb: "sent it back", tone: "warning" };

    case "TASK_COMPLETED":
      return { verb: "completed it", tone: "positive" };

    case "TASK_REOPENED":
      return { verb: "reopened it", tone: "warning" };

    case "TASK_CANCELLED":
      return { verb: "cancelled it", tone: "warning" };

    case "PRIORITY_CHANGED":
      return { verb: "changed the priority", detail: change, tone: "notable" };

    case "DUE_DATE_CHANGED":
      // The one everybody eventually asks about.
      return { verb: "moved the due date", detail: change, tone: "warning" };

    case "ESTIMATE_CHANGED":
      return { verb: "changed the estimate", detail: change, tone: "neutral" };

    case "BLOCKED":
      return { verb: "marked it blocked", tone: "warning" };

    case "UNBLOCKED":
      return { verb: "cleared the block", tone: "positive" };

    case "CONTRIBUTOR_ADDED":
      // Two events share this action: adding a contributor to the task, and
      // the automatic engagement membership that assignment creates.
      return entry.field === "engagementMember"
        ? { verb: "added", detail: `${to} to the engagement`, tone: "neutral" }
        : { verb: "added", detail: `${to} as a contributor`, tone: "neutral" };

    case "CONTRIBUTOR_REMOVED":
      return { verb: "removed", detail: `${from} as a contributor`, tone: "neutral" };

    case "COMMENT_ADDED":
      return { verb: "commented", tone: "neutral" };
    case "COMMENT_EDITED":
      return { verb: "edited a comment", tone: "neutral" };
    case "COMMENT_DELETED":
      return { verb: "deleted a comment", tone: "notable" };

    case "ATTACHMENT_ADDED":
      return { verb: "attached a file", detail: to, tone: "neutral" };
    case "ATTACHMENT_REMOVED":
      return { verb: "removed an attachment", detail: from, tone: "notable" };
    case "ATTACHMENT_DOWNLOADED":
      // Logged because this is where data leaves the system.
      return { verb: "downloaded an attachment", detail: to, tone: "neutral" };

    case "TIMER_STARTED":
      return { verb: "started a timer", tone: "neutral" };
    case "TIMER_STOPPED":
      return { verb: "stopped the timer", detail: to || undefined, tone: "neutral" };
    case "TIMER_SUSPENDED":
      return {
        verb: "left a timer running",
        detail: "it was suspended pending confirmation",
        tone: "warning",
      };
    case "TIMER_CONFIRMED":
      // Not "edited". The suspended entry held no time to change; its owner
      // is stating what they worked, which is a different act entirely.
      return { verb: "confirmed", detail: to, tone: "neutral" };

    case "TIME_LOGGED":
      return { verb: "logged", detail: to, tone: "neutral" };
    case "TIME_EDITED":
      return { verb: "edited a time entry", detail: change, tone: "warning" };
    case "TIME_DELETED":
      return { verb: "deleted a time entry", detail: from, tone: "warning" };

    case "REPORT_EXPORTED":
      return { verb: "exported a report", tone: "neutral" };

    default: {
      // A new ActivityAction with no sentence here breaks the build rather
      // than rendering a raw enum value on screen.
      const _exhaustive: never = entry.action;
      return { verb: String(_exhaustive), tone: "neutral" };
    }
  }
}

/** "2 hours ago", "yesterday", "26 Aug". */
export function relativeTime(at: Date, now = new Date()): string {
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  const minutesAgo = Math.round(seconds / 60);
  const hours = Math.round(minutesAgo / 60);
  const days = Math.round(hours / 24);

  if (seconds < 60) return "just now";
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
