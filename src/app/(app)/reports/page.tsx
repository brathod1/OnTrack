import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireActingUser } from "@/lib/auth/session";
import { can, visibleTaskFilter } from "@/lib/auth/permissions";
import { CAP } from "@/lib/auth/capabilities";
import { prisma } from "@/lib/db";
import { getTerminology } from "@/lib/org/terminology";
import { formatMinutes } from "@/lib/tasks/my-work";
import { defaultRange, getTimeReport } from "@/lib/reports/time-report";

export const metadata: Metadata = { title: "Reports · OnTrack" };

const ISO = (d: Date) => d.toISOString().slice(0, 10);
const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v: string | undefined): v is string => !!v && /^\d+$/.test(v);

/**
 * Where the hours went.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOT A PRODUCTIVITY REPORT. No rate per person, no utilisation percentage,
 * no comparison between people. It answers where the firm's EFFORT went, which
 * is a question about work — the same line the scope lock draws everywhere
 * else in this product.
 *
 * The download hands back the identical figures via the identical service, so
 * the spreadsheet can never disagree with the screen it came from.
 * ─────────────────────────────────────────────────────────────────────────
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActingUser();
  if (!can(actor, CAP.VIEW_REPORTS)) notFound();

  const sp = await searchParams;
  const terms = await getTerminology();
  const fallback = await defaultRange();

  const from = isDate(sp.from) ? new Date(`${sp.from}T00:00:00.000Z`) : fallback.from;
  const to = isDate(sp.to) ? new Date(`${sp.to}T00:00:00.000Z`) : fallback.to;
  const clientId = isId(sp.client) ? BigInt(sp.client) : undefined;
  const personId = isId(sp.person) ? BigInt(sp.person) : undefined;

  const rangeInverted = from > to;

  const [report, clients, people] = await Promise.all([
    rangeInverted
      ? null
      : getTimeReport(actor, { from, to, clientId, userId: personId }),

    prisma.client.findMany({
      where: { engagements: { some: { tasks: { some: visibleTaskFilter(actor) } } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { status: "ACTIVE", timeEntries: { some: { task: visibleTaskFilter(actor) } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const download = `/api/reports/time?${new URLSearchParams({
    from: ISO(from),
    to: ISO(to),
    ...(clientId ? { client: clientId.toString() } : {}),
    ...(personId ? { person: personId.toString() } : {}),
  }).toString()}`;

  return (
    <main className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Where the hours went</h1>
          <p className="text-sm text-slate-500">
            Time recorded against work you can see. Not a measure of anyone&rsquo;s
            productivity.
          </p>
        </div>

        {report && report.entryCount > 0 && (
          <a
            href={download}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Download spreadsheet
          </a>
        )}
      </header>

      {/* A plain GET form. No JavaScript needed, the URL is shareable, and the
          back button steps through previous ranges. */}
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            From
          </span>
          <input
            type="date"
            name="from"
            defaultValue={ISO(from)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            To
          </span>
          <input
            type="date"
            name="to"
            defaultValue={ISO(to)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            {terms.t("client")}
          </span>
          <select
            name="client"
            defaultValue={clientId?.toString() ?? ""}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {clients.map((c) => (
              <option key={c.id.toString()} value={c.id.toString()}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Person
          </span>
          <select
            name="person"
            defaultValue={personId?.toString() ?? ""}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id.toString()} value={p.id.toString()}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Show
        </button>
      </form>

      {rangeInverted && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The start date is after the end date.
        </p>
      )}

      {report && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <span className="text-2xl font-semibold tabular-nums text-slate-900">
              {formatMinutes(report.totalMinutes)}
            </span>
            <span className="text-sm text-slate-500">
              across {report.entryCount}{" "}
              {report.entryCount === 1 ? "entry" : "entries"}
            </span>
            {report.suspendedCount > 0 && (
              <span className="text-sm text-amber-700">
                {report.suspendedCount} unconfirmed{" "}
                {report.suspendedCount === 1 ? "timer" : "timers"} excluded — up to{" "}
                {formatMinutes(report.suspendedMinutesIfConfirmed)} not counted
              </span>
            )}
          </div>

          {report.entryCount === 0 ? (
            <p className="text-sm text-slate-500">
              No time recorded in this period.
            </p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[2fr,1fr]">
              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  By {terms.t("client").toLowerCase()}
                </h2>

                <div className="mt-2 space-y-3">
                  {report.clients.map((client) => (
                    <div
                      key={client.clientId}
                      className="overflow-hidden rounded-lg border border-slate-200 bg-white"
                    >
                      <div className="flex items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                        <span className="font-medium text-slate-900">
                          {client.name}
                          <span className="ml-2 text-xs font-normal text-slate-400">
                            {client.code}
                          </span>
                        </span>
                        <span className="font-medium tabular-nums text-slate-900">
                          {formatMinutes(client.minutes)}
                        </span>
                      </div>

                      <ul className="divide-y divide-slate-100">
                        {client.engagements.map((eng) => (
                          <li key={eng.engagementId} className="px-3 py-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm text-slate-800">
                                {eng.name}
                                {eng.fy && (
                                  <span className="ml-1.5 text-xs text-slate-400">
                                    {eng.fy}
                                  </span>
                                )}
                              </span>
                              <span className="text-sm tabular-nums text-slate-700">
                                {formatMinutes(eng.minutes)}
                              </span>
                            </div>

                            <ul className="mt-1 space-y-0.5">
                              {eng.people.map((p) => (
                                <li
                                  key={p.userId}
                                  className="flex items-baseline justify-between gap-2 text-xs text-slate-500"
                                >
                                  <span>{p.name}</span>
                                  <span className="tabular-nums">
                                    {formatMinutes(p.minutes)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  By person
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Hours recorded, in order of volume. Nothing here says anything
                  about pace.
                </p>

                <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                  {report.people.map((p) => (
                    <li
                      key={p.userId}
                      className="flex items-baseline justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="text-slate-800">{p.name}</span>
                      <span className="tabular-nums text-slate-700">
                        {formatMinutes(p.minutes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}
