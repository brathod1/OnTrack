import type { DueDateType, Priority, TaskStatus } from "@prisma/client";

/**
 * Shared presentational pieces for task lists and detail pages.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ACCESSIBILITY RULE APPLIED THROUGHOUT: nothing is distinguished by colour
 * alone. Every status carries a word, every priority carries a shape as well
 * as a hue, and overdue dates are bold as well as red.
 *
 * Roughly 8% of men have some colour vision deficiency — in a firm of 60,
 * that is two or three people who would otherwise be reading a table where
 * "urgent" and "routine" look identical. It also matters when someone prints
 * a report in black and white, which happens more than anyone admits.
 * ─────────────────────────────────────────────────────────────────────────
 */

// ── Status ──────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<TaskStatus, { label: string; className: string }> = {
  ASSIGNED: { label: "Assigned", className: "bg-slate-100 text-slate-700 ring-slate-200" },
  IN_PROGRESS: { label: "In progress", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  REVIEW: { label: "In review", className: "bg-purple-50 text-purple-700 ring-purple-200" },
  COMPLETED: { label: "Completed", className: "bg-green-50 text-green-700 ring-green-200" },
  CANCELLED: { label: "Cancelled", className: "bg-slate-50 text-slate-500 ring-slate-200" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.className}`}
    >
      {s.label}
    </span>
  );
}

// ── Priority ────────────────────────────────────────────────────────────────

const PRIORITY_STYLE: Record<Priority, { label: string; dot: string; text: string }> = {
  // The shapes differ, not just the colours: ▲ critical, ▲ high (smaller),
  // ● normal, ▼ low. Readable in greyscale.
  CRITICAL: { label: "Critical", dot: "▲", text: "text-red-600" },
  HIGH: { label: "High", dot: "▲", text: "text-orange-600" },
  NORMAL: { label: "Normal", dot: "●", text: "text-slate-400" },
  LOW: { label: "Low", dot: "▼", text: "text-slate-300" },
};

export function PriorityMark({ priority }: { priority: Priority }) {
  const p = PRIORITY_STYLE[priority];
  return (
    <span className={`${p.text} text-xs`} title={`${p.label} priority`}>
      <span aria-hidden="true">{p.dot}</span>
      <span className="sr-only">{p.label} priority</span>
    </span>
  );
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * Due dates are relative ("in 3 days", "6 days ago") with the absolute date in
 * the tooltip.
 *
 * "2026-08-20" requires the reader to work out whether that is soon. "6 days
 * overdue" does not. On a screen scanned every morning, that arithmetic is the
 * difference between noticing and not.
 */
export function DueDate({
  date,
  type,
  done,
  externalLabel = "Stat",
}: {
  date: Date;
  type?: DueDateType;
  done?: boolean;
  /**
   * What this organisation calls a fixed external deadline, in its short
   * form. "Stat" for a CA firm, "SLA" for a software company. Passed in
   * rather than looked up here, because this is a presentational component
   * and should not reach the database.
   */
  externalLabel?: string;
}) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);

  const iso = date.toISOString().slice(0, 10);
  const overdue = days < 0 && !done;
  // A date set outside the organisation. The LABEL comes from terminology
  // config — a CA firm calls it "Statutory", a software company "SLA" — but
  // the engine only knows that it cannot be moved.
  const external = type === "EXTERNAL_FIXED";

  let label: string;
  if (days === 0) label = "Today";
  else if (days === 1) label = "Tomorrow";
  else if (days === -1) label = "Yesterday";
  else if (days < 0) label = `${Math.abs(days)} days ago`;
  else if (days <= 14) label = `in ${days} days`;
  else label = iso;

  return (
    <span
      title={external ? `${iso} — ${externalLabel}` : iso}
      className={`tabular whitespace-nowrap text-sm ${
        overdue ? "font-semibold text-red-700" : "text-slate-600"
      }`}
    >
      {/* An external date is not the manager's to move. Marking it visibly
          stops people treating every date as negotiable. */}
      {external && (
        <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
          {externalLabel}
        </span>
      )}
      {label}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

// ── Flags ───────────────────────────────────────────────────────────────────

export function BlockedFlag({ reason }: { reason?: string | null }) {
  return (
    <span
      title={reason ?? "Blocked"}
      className="inline-flex items-center whitespace-nowrap rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange-800"
    >
      Blocked
    </span>
  );
}

export function ReworkFlag({ round }: { round: number }) {
  if (round <= 1) return null;
  return (
    <span
      title={`Sent back ${round - 1} time${round > 2 ? "s" : ""}`}
      className="inline-flex items-center whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800"
    >
      Round {round}
    </span>
  );
}

// ── Estimate vs actual ──────────────────────────────────────────────────────

/**
 * Shown as "2h 30m / 4h" — spent over estimated.
 *
 * Turns amber past the estimate and red past 150%, but ONLY as information for
 * the person doing the work and their manager. This never becomes a score:
 * see the metrics policy in the build spec. Being over an estimate is
 * frequently the estimate's fault.
 */
export function EstimateVsActual({
  estimateMinutes,
  actualMinutes,
}: {
  estimateMinutes: number | null;
  actualMinutes: number;
}) {
  const fmt = (m: number) => {
    if (m <= 0) return "0m";
    const h = Math.floor(m / 60);
    const min = m % 60;
    return h === 0 ? `${min}m` : min === 0 ? `${h}h` : `${h}h ${min}m`;
  };

  if (estimateMinutes === null) {
    return (
      <span className="tabular text-sm text-slate-400" title="No estimate set">
        {actualMinutes > 0 ? fmt(actualMinutes) : "—"}
        <span className="ml-1 text-xs">/ no est.</span>
      </span>
    );
  }

  const ratio = estimateMinutes === 0 ? 0 : actualMinutes / estimateMinutes;
  const tone =
    ratio > 1.5 ? "text-red-700" : ratio > 1 ? "text-amber-700" : "text-slate-600";

  return (
    <span className={`tabular whitespace-nowrap text-sm ${tone}`}>
      {fmt(actualMinutes)}
      <span className="text-slate-400"> / {fmt(estimateMinutes)}</span>
    </span>
  );
}

// ── Subtask progress ────────────────────────────────────────────────────────

export function SubtaskCount({ open }: { open: number }) {
  if (open === 0) return null;
  return (
    <span className="whitespace-nowrap text-xs text-slate-500" title={`${open} subtasks still open`}>
      {open} open
    </span>
  );
}
