import { format as formatDate } from "date-fns";
import type { NotificationType } from "@prisma/client";
import type { NotificationView } from "./service";

/**
 * How a date is written.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOT `toLocaleDateString`. That reads the SERVER's locale, which is a fact
 * about the machine rather than about the firm — this box renders "30 Sept
 * 2026" and an Azure host running en-US renders "Sep 30, 2026", so the same
 * notification reads differently depending on where it happened to be
 * rendered. Deploy to two regions and the product is inconsistent with itself.
 *
 * The organisation already stores a `dateFormat` (default "dd MMM yyyy",
 * because Indian firms read 26 Aug 2026, not 8/26/26). Callers with an
 * organisation to hand pass it; the default keeps this function usable
 * without one.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const DEFAULT_DATE_FORMAT = "d MMM yyyy";

/**
 * Turning a notification row into a line a person reads.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LINE MUST SAY WHAT TO DO, NOT WHAT HAPPENED TO A RECORD.
 *
 * "Task status changed to REVIEW" describes the database. "Kavya sent this
 * back — ITC reconciliation is missing" tells someone what their afternoon
 * looks like. The second costs nothing extra to produce and is the only
 * version anyone acts on.
 *
 * Every line carries the REASON where one exists, because a notification that
 * makes you open the task to find out what is being asked has wasted the
 * interruption it just spent.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface DescribedNotification {
  /** The bold half — what happened. */
  headline: string;
  /** The quieter half — the reason, excerpt, or dates. Often absent. */
  detail: string | null;
  /** Drives the colour of the marker. Not decoration: rejection is not news. */
  tone: "neutral" | "attention" | "warning";
}

function payloadOf(n: NotificationView): Record<string, unknown> {
  return (n.payload ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A calendar day, written the way the organisation writes dates. */
function day(iso: unknown, pattern: string): string | null {
  const s = str(iso);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  try {
    return formatDate(d, pattern);
  } catch {
    // A misconfigured pattern must not take the notifications page down.
    return formatDate(d, DEFAULT_DATE_FORMAT);
  }
}

export function describeNotification(
  n: NotificationView,
  dateFormat: string = DEFAULT_DATE_FORMAT
): DescribedNotification {
  const p = payloadOf(n);
  const type = n.type as NotificationType;
  const day_ = (iso: unknown) => day(iso, dateFormat);

  switch (type) {
    case "ASSIGNED_TO_ME": {
      const due = day_(p.dueDate);
      return {
        headline: "Assigned to you",
        // The deadline is the first thing anyone wants to know on being given
        // work, so it travels with the notification rather than one click away.
        detail: str(p.reason) ?? (due ? `Due ${due}` : null),
        tone: "attention",
      };
    }

    case "REVIEW_REQUESTED":
      return {
        headline: "Waiting for your review",
        detail: null,
        tone: "attention",
      };

    case "REVIEW_REJECTED":
      return {
        headline: "Sent back to you",
        // Never null in practice — the workflow requires a reason to reject —
        // but rendered defensively rather than assuming.
        detail: str(p.reason),
        tone: "warning",
      };

    case "DUE_DATE_CHANGED": {
      const from = day_(p.from);
      const to = day_(p.to);
      return {
        headline: to ? `Deadline moved to ${to}` : "Deadline moved",
        detail: str(p.reason) ?? (from ? `Was ${from}` : null),
        tone: "warning",
      };
    }

    case "MENTIONED":
      return {
        headline: "Mentioned you",
        detail: str(p.excerpt),
        tone: "neutral",
      };

    case "ADDED_AS_CONTRIBUTOR":
      return {
        headline: "Added you as a contributor",
        detail: "You can log time against this work.",
        tone: "neutral",
      };

    default: {
      // A type added to the schema but not here. Renders as something rather
      // than crashing the page, and is obviously wrong to whoever added it.
      const exhaustive: never = type;
      return { headline: String(exhaustive), detail: null, tone: "neutral" };
    }
  }
}

/**
 * "just now", "3h ago", "yesterday", "12 Aug".
 *
 * Relative up to a week, then a date — because "23d ago" makes the reader do
 * arithmetic to work out when that was, and a date does not.
 */
export function shortAgo(when: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - when.getTime()) / 1000));

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;

  // Same reasoning as `day` above: deterministic, not the server's locale.
  return formatDate(when, "d MMM");
}
