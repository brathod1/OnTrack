import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Priority, TaskStatus } from "@prisma/client";
import { requireActingUser } from "@/lib/auth/session";
import { can, visibleTaskFilter } from "@/lib/auth/permissions";
import { CAP } from "@/lib/auth/capabilities";
import { prisma } from "@/lib/db";
import { getTerminology } from "@/lib/org/terminology";
import { listTasks } from "@/lib/tasks/service";
import { listTasksSchema } from "@/lib/tasks/schemas";
import { STATUS_LABELS } from "@/lib/tasks/transitions";
import { formatMinutes } from "@/lib/tasks/my-work";
import { TaskFilters } from "@/components/task-filters";
import { BlockedFlag, DueDate, PriorityMark, StatusBadge } from "@/components/task-ui";

export const metadata: Metadata = { title: "Browse · OnTrack" };

const PAGE_SIZE = 50;

/**
 * Browse everything you can see.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "BROWSE", NOT "ALL TASKS". The results are relationship-filtered for
 * everyone who opens it, so "All" would be a lie to every non-administrator —
 * and a lie of exactly the kind that makes someone believe a client has no
 * outstanding work when in fact they simply cannot see it.
 *
 * The screen is gated on VIEW_PORTFOLIO, which exists to permit THIS PAGE and
 * grants no scope of its own. `visibleTaskFilter` still decides what is
 * returned, inside `listTasks`, exactly as it does for My Work.
 * ─────────────────────────────────────────────────────────────────────────
 */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requireActingUser();
  if (!can(actor, CAP.VIEW_PORTFOLIO)) notFound();

  const sp = await searchParams;
  const terms = await getTerminology();

  // Parsed through the same schema the API uses. A hand-rolled parse here
  // would be a second definition of what a filter means.
  const parsed = listTasksSchema.safeParse({
    search: sp.q || undefined,
    clientId: sp.client || undefined,
    // Arrived here from the clients directory, which links to one engagement
    // rather than a whole client.
    engagementId: sp.engagement || undefined,
    assigneeId: sp.assignee || undefined,
    status: sp.status ? [sp.status] : undefined,
    priority: sp.priority ? [sp.priority] : undefined,
    overdue: sp.overdue === "1" ? true : undefined,
    blocked: sp.blocked === "1" ? true : undefined,
    cursor: sp.cursor || undefined,
    limit: PAGE_SIZE,
  });

  // A malformed URL — someone editing it by hand, or a stale bookmark — falls
  // back to the unfiltered view rather than erroring. Nothing here is
  // destructive, so refusing to render would be a worse answer than ignoring
  // the part that made no sense.
  const filters = parsed.success
    ? parsed.data
    : listTasksSchema.parse({ limit: PAGE_SIZE });

  const [result, clients, people, engagement] = await Promise.all([
    listTasks(actor, filters),

    // Only clients the user can actually reach work on — otherwise the filter
    // list itself becomes a directory of the firm's entire client base.
    prisma.client.findMany({
      where: { engagements: { some: { tasks: { some: visibleTaskFilter(actor) } } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),

    // Same reasoning: people who appear on work this user can see.
    prisma.user.findMany({
      where: { status: "ACTIVE", tasksAssigned: { some: visibleTaskFilter(actor) } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),

    // Named only when the filter is in play, so it costs a query on the way in
    // from the clients directory and nothing otherwise. Without it the list is
    // filtered by something the page never mentions.
    filters.engagementId
      ? prisma.engagement.findFirst({
          where: {
            AND: [{ id: filters.engagementId }, { tasks: { some: visibleTaskFilter(actor) } }],
          },
          select: { name: true, client: { select: { name: true } } },
        })
      : Promise.resolve(null),
  ]);

  const activeFilters = [
    sp.q,
    sp.client,
    sp.engagement,
    sp.assignee,
    sp.status,
    sp.priority,
    sp.overdue,
    sp.blocked,
  ].filter(Boolean).length;

  const nextHref = result.nextCursor
    ? `/browse?${new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][]
        ),
        cursor: result.nextCursor.toString(),
      }).toString()}`
    : null;

  return (
    <main className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Browse</h1>
        <p className="text-sm text-slate-500">
          Every {terms.t("task").toLowerCase()} you can see — yours and your
          team&rsquo;s.
        </p>
      </header>

      <TaskFilters
        clientLabel={terms.t("client")}
        clients={clients.map((c) => ({ value: c.id.toString(), label: c.name }))}
        people={people.map((p) => ({ value: p.id.toString(), label: p.name }))}
        statuses={Object.values(TaskStatus).map((s) => ({
          value: s,
          label: STATUS_LABELS[s] ?? s,
        }))}
        priorities={Object.values(Priority).map((p) => ({
          value: p,
          label: p.charAt(0) + p.slice(1).toLowerCase(),
        }))}
      />

      {engagement && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Showing {engagement.client.name} — {engagement.name}.{" "}
          <Link href="/browse" className="underline">
            Show everything
          </Link>
        </p>
      )}

      {!parsed.success && activeFilters > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Part of that link could not be read, so it has been ignored.
        </p>
      )}

      <p className="text-sm text-slate-500">
        {result.tasks.length === 0
          ? "Nothing matches."
          : `${result.tasks.length}${result.nextCursor ? "+" : ""} ${
              result.tasks.length === 1
                ? terms.t("task").toLowerCase()
                : terms.plural("task").toLowerCase()
            }`}
        {activeFilters > 0 && " matching your filters"}
      </p>

      {result.tasks.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {result.tasks.map((task) => (
              <li key={task.id.toString()}>
                <Link
                  href={`/tasks/${task.displayKey}`}
                  className="flex flex-col gap-1.5 px-3 py-2.5 hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3"
                >
                  <PriorityMark priority={task.priority} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium text-slate-900">
                        {task.title}
                      </span>
                      {task.isBlocked && <BlockedFlag reason={task.blockedReason} />}
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span className="tabular">{task.displayKey}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">
                        {task.engagement.client.code} — {task.engagement.name}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{task.assignee.name}</span>
                      {/* Shown only when somebody ELSE asked for it. Suppressed
                          when the assignee created their own task (nobody asked
                          them) and when YOU did (you already know) — otherwise
                          the one case worth noticing, a request that crossed
                          teams, is buried in a name on every row. */}
                      {task.createdBy.id !== task.assigneeId &&
                        task.createdBy.id !== actor.id && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate italic">
                              asked by {task.createdBy.name}
                            </span>
                          </>
                        )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <span className="tabular text-slate-500">
                      {formatMinutes(task.actualMinutes)}
                      {task.currentEstimateMinutes
                        ? ` / ${formatMinutes(task.currentEstimateMinutes)}`
                        : ""}
                    </span>
                    <StatusBadge status={task.status} />
                    <DueDate
                      date={task.dueDate}
                      type={task.dueDateType}
                      done={
                        task.status === TaskStatus.COMPLETED ||
                        task.status === TaskStatus.CANCELLED
                      }
                      externalLabel={terms.short("externalDeadline")}
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {nextHref && (
        <Link
          href={nextHref}
          className="inline-block rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Load more
        </Link>
      )}
    </main>
  );
}
