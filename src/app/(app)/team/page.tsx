import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActingUser } from "@/lib/auth/session";
import { canOverseeOthers } from "@/lib/auth/permissions";
import { getTerminology } from "@/lib/org/terminology";
import { getDashboard, type RiskRow } from "@/lib/dashboard/service";
import { formatMinutes } from "@/lib/tasks/my-work";

export const metadata: Metadata = { title: "Team · OnTrack" };

/**
 * The manager's page.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ORDERED BY URGENCY, NOT BY CATEGORY. Risk first, because that is what
 * someone opens this page to find. Load second, because the usual response to
 * risk is to move work. Clients last, because that question is asked monthly,
 * not daily.
 *
 * EVERY NUMBER IS A LINK. A dashboard that shows you a count and leaves you to
 * go and find the six tasks behind it has moved the work rather than done it.
 *
 * NOTHING RANKS PEOPLE. The load table is sorted by hours committed, which is
 * a fact about work queued, not a judgement about the person carrying it —
 * and there is deliberately no column for speed, throughput or accuracy.
 * ─────────────────────────────────────────────────────────────────────────
 */
export default async function TeamPage() {
  const actor = await requireActingUser();

  // A screen gate. Someone without it gets 404 rather than 403 — consistent
  // with the rest of the product, where the existence of a page you may not
  // have is itself not information worth confirming.
  if (!canOverseeOthers(actor)) notFound();

  const terms = await getTerminology();
  const d = await getDashboard(actor);

  return (
    <main className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Team</h1>
          <p className="text-sm text-slate-500">
            Everything you oversee. {d.totals.openTasks} open{" "}
            {terms.plural("task").toLowerCase()} across {d.totals.people}{" "}
            {d.totals.people === 1 ? "person" : "people"}.
          </p>
        </div>

        {d.totals.unestimated > 0 && (
          <p className="text-xs text-slate-500">
            {d.totals.unestimated} without an estimate — not counted in any
            hours figure below.
          </p>
        )}
      </header>

      {/* ── 1. What is at risk ───────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          At risk
        </h2>

        {d.overdue.length === 0 &&
        d.dueThisWeek.length === 0 &&
        d.stalledBlocked.length === 0 &&
        d.stalledReview.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Nothing overdue, stalled, or due in the next week.
          </p>
        ) : (
          <div className="mt-2 grid gap-4 md:grid-cols-2">
            <RiskPanel
              title="Overdue"
              rows={d.overdue}
              tone="danger"
              unit="late"
              empty="Nothing overdue."
            />
            <RiskPanel
              title="Due within a week"
              rows={d.dueThisWeek}
              tone="warn"
              unit="away"
              empty="Nothing due this week."
            />
            <RiskPanel
              title={`Blocked over ${d.stallDays} days`}
              rows={d.stalledBlocked}
              tone="warn"
              unit="blocked"
              empty="No long-running blocks."
              note="A block nobody has cleared is usually waiting on a person, not a process."
            />
            <RiskPanel
              title={`In review over ${d.stallDays} days`}
              rows={d.stalledReview}
              tone="warn"
              unit="waiting"
              empty="No review backlog."
              note="Work finished by one person and not yet looked at by another."
            />
          </div>
        )}
      </section>

      {/* ── 2. Where the load is ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Where the load is
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Hours still committed, counting each piece of work once. This is what
          people are carrying — it is not a measure of how fast they work.
        </p>

        {d.load.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nobody has open work.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th className="px-3 py-2 font-medium text-slate-600">Person</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Open</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Overdue</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.load.map((p) => (
                  <tr key={p.userId} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-medium text-slate-900">{p.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.openTasks}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        p.overdue > 0 ? "font-medium text-red-700" : "text-slate-400"
                      }`}
                    >
                      {p.overdue || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMinutes(p.remainingMinutes)}
                      {p.unestimated > 0 && (
                        <span
                          className="ml-1.5 text-xs font-normal text-slate-500"
                          title={`${p.unestimated} of their tasks have no estimate and are not counted`}
                        >
                          +{p.unestimated} unest.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 3. What each client is absorbing ─────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {terms.plural("client")}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Hours recorded against open work, and what is still committed to it.
        </p>

        {d.clients.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No open work.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th className="px-3 py-2 font-medium text-slate-600">
                    {terms.t("client")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Open</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Overdue</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">Logged</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-600">
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.clients.map((c) => (
                  <tr key={c.clientId} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium text-slate-900">{c.name}</span>
                      <span className="ml-1.5 text-xs text-slate-400">{c.code}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.openTasks}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        c.overdue > 0 ? "font-medium text-red-700" : "text-slate-400"
                      }`}
                    >
                      {c.overdue || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {formatMinutes(c.loggedMinutes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMinutes(c.remainingMinutes)}
                      {c.unestimated > 0 && (
                        <span
                          className="ml-1.5 text-xs font-normal text-slate-500"
                          title={`${c.unestimated} tasks have no estimate and are not counted`}
                        >
                          +{c.unestimated} unest.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-2 text-xs text-slate-400">
          Hours logged cover open work only. Effort on{" "}
          {terms.plural("task").toLowerCase()} already completed is a report,
          not a dashboard figure.
        </p>
      </section>
    </main>
  );
}

/** One risk bucket. Shows the worst few and says how many more there are. */
function RiskPanel({
  title,
  rows,
  tone,
  unit,
  empty,
  note,
}: {
  title: string;
  rows: RiskRow[];
  tone: "danger" | "warn";
  unit: string;
  empty: string;
  note?: string;
}) {
  // Five, then a link. A panel that lists forty items is a task list wearing a
  // dashboard's clothes, and the point here is to be readable at a glance.
  const shown = rows.slice(0, 5);
  const more = rows.length - shown.length;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        <span
          className={`text-sm font-semibold tabular-nums ${
            rows.length === 0
              ? "text-slate-300"
              : tone === "danger"
                ? "text-red-700"
                : "text-amber-700"
          }`}
        >
          {rows.length}
        </span>
      </div>

      {note && rows.length > 0 && (
        <p className="mt-0.5 text-xs text-slate-400">{note}</p>
      )}

      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {shown.map((r) => (
            <li key={r.id}>
              <Link
                href={`/tasks/${r.key}`}
                className="flex items-baseline justify-between gap-3 hover:underline"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-800">
                    {r.title}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.clientName} · {r.assigneeName}
                    {/* Only when somebody ELSE put this on their plate — see
                        RiskRow.requestedByName. Without it a row shows who is
                        doing the work and never who pulled them in, which is
                        the whole question when a request crosses teams. */}
                    {r.requestedByName && (
                      <span className="italic"> · asked by {r.requestedByName}</span>
                    )}
                    {r.isStatutory && (
                      <span
                        className="ml-1.5 font-medium text-orange-700"
                        title="A statutory deadline cannot be renegotiated"
                      >
                        STAT
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-xs tabular-nums ${
                    tone === "danger" ? "text-red-700" : "text-slate-500"
                  }`}
                >
                  {r.days}d {unit}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {more > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          and {more} more
        </p>
      )}
    </div>
  );
}
