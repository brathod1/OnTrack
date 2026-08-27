import type { Metadata } from "next";
import Link from "next/link";
import { requireActingUser } from "@/lib/auth/session";
import { getTerminology } from "@/lib/org/terminology";
import { getClientDirectory } from "@/lib/clients/directory";
import { formatMinutes } from "@/lib/tasks/my-work";

export const metadata: Metadata = { title: "Clients · OnTrack" };

/**
 * Not gated on a capability, deliberately.
 *
 * Everyone sees the clients they already have work on — the page is built from
 * the tasks the relationship model already lets them read, so it discloses
 * nothing new. A junior on one engagement sees one client here; withholding
 * the page from them would mean they could open a task and not see what it
 * belonged to.
 */
export default async function ClientsPage() {
  const actor = await requireActingUser();
  const terms = await getTerminology();
  const clients = await getClientDirectory(actor);

  if (clients.length === 0) {
    return (
      <main>
        <h1 className="text-xl font-semibold text-slate-900">
          {terms.plural("client")}
        </h1>
        <p className="mt-3 text-sm text-slate-500">
          You have no work on any {terms.t("client").toLowerCase()} yet.
        </p>
      </main>
    );
  }

  return (
    <main className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">
          {terms.plural("client")}
        </h1>
        <p className="text-sm text-slate-500">
          {terms.plural("client")} you have work on, and the{" "}
          {terms.plural("engagement").toLowerCase()} within them.
        </p>
      </header>

      <div className="space-y-3">
        {clients.map((client) => (
          <section
            key={client.id}
            className="overflow-hidden rounded-lg border border-slate-200 bg-white"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
              <div>
                <h2 className="font-medium text-slate-900">
                  {client.name}
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    {client.code}
                  </span>
                </h2>
                {client.partnerName && (
                  <p className="text-xs text-slate-500">
                    Relationship partner · {client.partnerName}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 text-sm">
                {client.overdue > 0 && (
                  <span className="font-medium text-red-700">
                    {client.overdue} overdue
                  </span>
                )}
                <span className="text-slate-500">
                  {client.openTasks} open
                </span>
                {/* Straight into Browse rather than a list of its own. One
                    screen renders tasks; one definition of filtering. */}
                <Link
                  href={`/browse?client=${client.id}`}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-white"
                >
                  Browse
                </Link>
              </div>
            </div>

            <ul className="divide-y divide-slate-100">
              {client.engagements.map((eng) => {
                const closed = eng.status !== "ACTIVE";
                return (
                  <li key={eng.id}>
                    <Link
                      href={`/browse?engagement=${eng.id}`}
                      className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 hover:bg-slate-50 ${
                        closed ? "opacity-55" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <span className="block truncate text-sm text-slate-900">
                          {eng.name}
                          {eng.fy && (
                            <span className="ml-2 text-xs text-slate-400">{eng.fy}</span>
                          )}
                          {closed && (
                            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                              {eng.status.toLowerCase()}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {[eng.partnerName, eng.managerName]
                            .filter(Boolean)
                            .join(" · ") || "No partner or manager named"}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-4 text-sm tabular-nums">
                        {eng.overdue > 0 && (
                          <span className="font-medium text-red-700">
                            {eng.overdue} overdue
                          </span>
                        )}
                        <span className="text-slate-500">
                          {eng.openTasks > 0 ? `${eng.openTasks} open` : "—"}
                        </span>
                        <span
                          className="w-16 text-right text-slate-600"
                          title="Hours recorded against this engagement, including completed work"
                        >
                          {formatMinutes(eng.loggedMinutes)}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-xs text-slate-400">
        Only {terms.plural("client").toLowerCase()} you have work on appear here.
        Hours cover all work including {terms.plural("task").toLowerCase()}{" "}
        already completed.
      </p>
    </main>
  );
}
