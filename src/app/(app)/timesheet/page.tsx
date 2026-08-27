import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActingUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import { getCurrentOrganization } from "@/lib/org/current";
import { formatDuration } from "@/lib/time/duration";
import { getTimesheet, getTimesheetSubjects } from "@/lib/time/timesheet";
import { TimesheetPersonPicker } from "@/components/timesheet-person-picker";

export const metadata: Metadata = { title: "Timesheet · OnTrack" };

const ISO_DATE = (d: Date) => d.toISOString().slice(0, 10);

export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; user?: string }>;
}) {
  const params = await searchParams;
  const actor = await requireActingUser();
  const org = await getCurrentOrganization();

  const weekStart = params.week && /^\d{4}-\d{2}-\d{2}$/.test(params.week)
    ? new Date(`${params.week}T00:00:00.000Z`)
    : undefined;

  const subjectId = params.user && /^\d+$/.test(params.user)
    ? BigInt(params.user)
    : undefined;

  let sheet;
  try {
    sheet = await getTimesheet(actor, { weekStart, userId: subjectId });
  } catch (e) {
    // A timesheet you have no standing to read is not found, not forbidden —
    // the same answer as a person who does not exist. Confirming that someone
    // works here, by name, is itself information.
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

  const subjects = await getTimesheetSubjects(actor);

  const href = (week: Date, user?: bigint) =>
    `/timesheet?week=${ISO_DATE(week)}${user ? `&user=${user}` : ""}`;

  const weekLabel = `${sheet.days[0]!.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })} – ${sheet.days[6]!.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {sheet.isOwnSheet ? "My timesheet" : `${sheet.subject.name}'s timesheet`}
          </h1>
          <p className="text-sm text-slate-500">{weekLabel}</p>
        </div>

        <div className="flex items-center gap-2">
          {subjects.length > 0 && (
            <TimesheetPersonPicker
              subjects={subjects.map((s) => ({
                id: s.id.toString(),
                name: s.name,
              }))}
              selectedId={sheet.isOwnSheet ? "" : sheet.subject.id.toString()}
              weekStart={ISO_DATE(sheet.weekStart)}
            />
          )}

          <nav className="flex items-center gap-1">
            <Link
              href={href(sheet.previousWeek, subjectId)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-100"
            >
              ← Previous
            </Link>
            <Link
              href={`/timesheet${subjectId ? `?user=${subjectId}` : ""}`}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-100"
            >
              This week
            </Link>
            {/* Next is absent, not disabled, when the week has not happened —
                a dead button invites clicking to find out why. */}
            {sheet.canGoForward && (
              <Link
                href={href(sheet.nextWeek, subjectId)}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-100"
              >
                Next →
              </Link>
            )}
          </nav>
        </div>
      </header>

      {sheet.suspendedCount > 0 && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {sheet.suspendedCount === 1
            ? "One timer was left running and is waiting to be confirmed. It counts toward nothing until then."
            : `${sheet.suspendedCount} timers were left running and are waiting to be confirmed. They count toward nothing until then.`}{" "}
          Open the task to say how long you worked.
        </p>
      )}

      {sheet.emptyWorkingDays.length > 0 && (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Nothing recorded on{" "}
          {sheet.emptyWorkingDays
            .map((d) => d.toLocaleDateString(undefined, { weekday: "long" }))
            .join(", ")}
          .
        </p>
      )}

      {sheet.rows.length === 0 ? (
        <p className="mt-8 text-sm text-slate-500">
          No time recorded this week.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-3 py-2 text-left font-medium text-slate-600">
                  Work
                </th>
                {sheet.days.map((d) => {
                  const isoWeekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
                  const working = org.workingDays.includes(isoWeekday);
                  return (
                    <th
                      key={d.toISOString()}
                      className={`w-20 px-2 py-2 text-right font-medium ${
                        working ? "text-slate-600" : "text-slate-400"
                      }`}
                    >
                      <span className="block">
                        {d.toLocaleDateString(undefined, { weekday: "short" })}
                      </span>
                      <span className="block text-xs font-normal">
                        {d.getUTCDate()}
                      </span>
                    </th>
                  );
                })}
                <th className="w-24 px-3 py-2 text-right font-medium text-slate-600">
                  Total
                </th>
              </tr>
            </thead>

            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.taskId.toString()} className="border-b border-slate-100">
                  <td className="px-3 py-2">
                    <Link
                      href={`/tasks/${row.taskKey}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {row.taskTitle}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {row.clientName} · {row.engagementName} · {row.taskKey}
                    </span>
                  </td>

                  {row.cells.map((cell, i) => {
                    const suspended = cell.entries.some((e) => e.isSuspended);
                    const touched = cell.entries.some((e) => e.editedByOther);
                    return (
                      <td
                        key={i}
                        className={`px-2 py-2 text-right tabular-nums ${
                          suspended ? "bg-amber-50" : ""
                        }`}
                        title={
                          cell.entries
                            .map((e) =>
                              e.isSuspended
                                ? "Awaiting confirmation"
                                : [formatDuration(e.minutes), e.note]
                                    .filter(Boolean)
                                    .join(" — ")
                            )
                            .join("\n") || undefined
                        }
                      >
                        {cell.minutes > 0 ? formatDuration(cell.minutes) : ""}
                        {suspended && (
                          <span className="block text-xs text-amber-700">
                            unconfirmed
                          </span>
                        )}
                        {touched && !suspended && (
                          <span
                            className="block text-xs text-slate-400"
                            title="Changed by a manager"
                          >
                            edited
                          </span>
                        )}
                      </td>
                    );
                  })}

                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatDuration(row.totalMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-medium">
                <td className="px-3 py-2 text-slate-700">Total</td>
                {sheet.dailyTotals.map((m, i) => (
                  <td key={i} className="px-2 py-2 text-right tabular-nums">
                    {m > 0 ? formatDuration(m) : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatDuration(sheet.weekTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!sheet.isOwnSheet && (
        <p className="mt-4 text-xs text-slate-400">
          You are looking at someone else&rsquo;s recorded time because you
          oversee them. Any correction you make is attributed to you and shown
          to them.
        </p>
      )}
    </main>
  );
}
