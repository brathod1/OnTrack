import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireActingUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { getTaskDetail, type ActivityEntry } from "@/lib/tasks/detail";
import { describeActivity, relativeTime } from "@/lib/activity/describe";
import { getTerminology } from "@/lib/org/terminology";
import { formatMinutes } from "@/lib/tasks/my-work";
import {
  BlockedFlag,
  DueDate,
  EstimateVsActual,
  PriorityMark,
  ReworkFlag,
  StatusBadge,
} from "@/components/task-ui";
import { TaskActions } from "@/components/task-actions";
import { TaskComments } from "@/components/task-comments";
import { TaskContributors } from "@/components/task-contributors";
import {
  getMentionableUsers,
  isEditable,
  listComments,
} from "@/lib/tasks/comments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { key } = await params;
  return { title: key };
}

/**
 * Task detail.
 *
 * Read-only in this stage. Transitions arrive in Stage 9, comments in Stage
 * 10, the timer in Stage 11 — the permitted actions are already computed
 * server-side and shown disabled, so the shape of the page does not change
 * when they are wired up.
 *
 * A task the caller may not see calls notFound(), rendering exactly what a
 * task that does not exist renders. Nothing on the page, in the title or in
 * the status code distinguishes the two.
 */
export default async function TaskDetailPage({ params }: Params) {
  const { key } = await params;
  const actor = await requireActingUser();
  const terms = await getTerminology();

  let detail;
  try {
    detail = await getTaskDetail(actor, key);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const { task, activity, timeByPerson, totalMinutes, canManage, transitions } = detail;

  const [comments, mentionable, activeUsers] = await Promise.all([
    listComments(actor, task.id),
    // Narrow on purpose: mentioning someone who cannot open the task invites
    // them to a room they have no key for.
    getMentionableUsers(actor, task.id),
    // Broad on purpose: adding a contributor is how someone GAINS access, the
    // same way assigning work adds engagement membership. Restricting this to
    // people already on the engagement would make it impossible to pull in a
    // colleague from another team — which is exactly when you want to.
    prisma.user.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, team: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  // The edit window and delete rights are decided server-side and passed down
  // as booleans. A client deciding "was this within fifteen minutes?" against
  // its own clock would disagree with the server the moment they drift.
  const commentViews = comments.map((c) => ({
    id: c.id.toString(),
    bodyMd: c.bodyMd,
    authorId: c.author.id.toString(),
    authorName: c.author.name,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    deletedAt: c.deletedAt?.toISOString() ?? null,
    canEdit: isEditable(c, c.author.id, actor.id),
    canDelete: !c.deletedAt && (c.author.id === actor.id || canManage),
  }));

  // Activity values carry user ids as strings. Resolve them in one query
  // rather than per row.
  const idsInActivity = new Set<string>();
  for (const a of activity) {
    for (const v of [a.oldValue, a.newValue]) {
      if (typeof v === "string" && /^\d+$/.test(v)) idsInActivity.add(v);
      if (v && typeof v === "object" && "userId" in v) {
        idsInActivity.add(String((v as { userId: unknown }).userId));
      }
    }
  }
  const referenced = idsInActivity.size
    ? await prisma.user.findMany({
        where: { id: { in: [...idsInActivity].map((s) => BigInt(s)) } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = (id: string) =>
    referenced.find((u) => u.id.toString() === id)?.name ?? `#${id}`;

  const closed = task.status === "COMPLETED" || task.status === "CANCELLED";

  return (
    <main>
      {/* ── Breadcrumb ──────────────────────────────────────────────────── */}
      <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
        <Link href="/tasks" className="hover:text-slate-900">
          My work
        </Link>
        <span aria-hidden="true">/</span>
        <span>{task.engagement.client.name}</span>
        <span aria-hidden="true">/</span>
        <span>
          {task.engagement.name}
          {task.engagement.fy ? ` ${task.engagement.fy}` : ""}
        </span>
        {task.parentTask && (
          <>
            <span aria-hidden="true">/</span>
            <Link
              href={`/tasks/${task.parentTask.displayKey}`}
              className="hover:text-slate-900"
            >
              {task.parentTask.title}
            </Link>
          </>
        )}
      </nav>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-200 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityMark priority={task.priority} />
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                {task.title}
              </h1>
              {task.isBlocked && <BlockedFlag reason={task.blockedReason} />}
              <ReworkFlag round={task.reviewRound} />
            </div>
            <p className="tabular mt-1 text-sm text-slate-500">{task.displayKey}</p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <StatusBadge status={task.status} />
            <DueDate
              date={task.dueDate}
              type={task.dueDateType}
              done={closed}
              externalLabel={terms.short("externalDeadline")}
            />
          </div>
        </div>

        {/*
          Actions the caller may take, computed by the permission kernel. The
          component renders exactly this list and makes no judgement of its
          own — and every mutation re-checks server-side anyway, so a client
          that ignored it would gain nothing.

          `version` is the optimistic lock: the updatedAt the page was
          rendered from. A write against a stale one is refused with a 409,
          and the user is offered a reload rather than a silent retry.
        */}
        <TaskActions
          taskKey={task.displayKey}
          version={task.updatedAt.toISOString()}
          transitions={transitions.map((t) => ({
            to: t.to,
            label: t.label,
            requiresReason: t.requiresReason,
          }))}
          canManage={canManage}
          isBlocked={task.isBlocked}
          blockedReason={task.blockedReason}
          // Blocking a finished task means nothing; the server refuses it too.
          canBlock={!closed && (canManage || task.assignee.id === actor.id)}
        />
      </header>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        {/* ── Left: description, subtasks, timeline ─────────────────────── */}
        <div className="space-y-6 md:col-span-2">
          {task.description && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">Notes</h2>
              <div className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-800">
                {task.description}
              </div>
            </section>
          )}

          {task.cancelReason && (
            <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <h2 className="text-sm font-semibold text-amber-900">Cancelled</h2>
              <p className="mt-1 text-sm text-amber-900">{task.cancelReason}</p>
            </section>
          )}

          {task.isBlocked && (
            <section className="rounded-lg border border-orange-300 bg-orange-50 p-4">
              <h2 className="text-sm font-semibold text-orange-900">
                Blocked
                {task.blockedSince && (
                  <span className="ml-2 font-normal">
                    since {relativeTime(task.blockedSince)}
                  </span>
                )}
              </h2>
              <p className="mt-1 text-sm text-orange-900">{task.blockedReason}</p>
              {task.expectedUnblockDate && (
                <p className="mt-1 text-xs text-orange-800">
                  Expected clear by {task.expectedUnblockDate.toISOString().slice(0, 10)}
                </p>
              )}
            </section>
          )}

          {task.subtasks.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                {terms.plural("subtask")}
                <span className="tabular ml-2 text-xs font-normal text-slate-400">
                  {task.subtasks.filter((s) => s.status === "COMPLETED").length} of{" "}
                  {task.subtasks.length} done
                </span>
              </h2>
              <ul className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                {task.subtasks.map((s) => (
                  <li key={s.displayKey} className="border-b border-slate-100 last:border-b-0">
                    <Link
                      href={`/tasks/${s.displayKey}`}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1 truncate text-slate-900">{s.title}</span>
                      {s.isBlocked && <BlockedFlag />}
                      <span className="hidden text-xs text-slate-500 sm:inline">
                        {s.assignee.name}
                      </span>
                      <StatusBadge status={s.status} />
                      <span className="w-24 text-right">
                        <DueDate
                          date={s.dueDate}
                          type={s.dueDateType}
                          done={s.status === "COMPLETED" || s.status === "CANCELLED"}
                          externalLabel={terms.short("externalDeadline")}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <TaskComments
            taskKey={task.displayKey}
            comments={commentViews}
            mentionable={mentionable.map((m) => ({
              id: m.id.toString(),
              name: m.name,
            }))}
            currentUserId={actor.id.toString()}
          />

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">History</h2>
            <Timeline entries={activity} nameOf={nameOf} />
          </section>
        </div>

        {/* ── Right: the facts ──────────────────────────────────────────── */}
        <aside className="space-y-4">
          <Panel title="People">
            <Row label="Assignee" value={task.assignee.name} />
            {/* "Review by", not "Review" — the row names a person, and the
                term stays configurable ("QA by" elsewhere). */}
            {task.reviewer && (
              <Row label={`${terms.t("review")} by`} value={task.reviewer.name} />
            )}
            {task.assignedBy && <Row label="Assigned by" value={task.assignedBy.name} />}
            <Row label="Created by" value={task.createdBy.name} />
          </Panel>

          <TaskContributors
            taskKey={task.displayKey}
            contributors={task.contributors.map((c) => ({
              id: c.userId.toString(),
              name: c.user.name,
              addedBy: c.addedBy.name,
            }))}
            candidates={activeUsers
              .filter(
                (u) =>
                  u.id !== task.assignee.id &&
                  !task.contributors.some((c) => c.userId === u.id)
              )
              .map((u) => ({
                id: u.id.toString(),
                // Team shown because "Anjali Nair" is ambiguous in a firm of
                // sixty and "Anjali Nair (Direct Tax)" is not.
                name: u.team?.name ? `${u.name} (${u.team.name})` : u.name,
              }))}
            // Adding someone to work they do not own is a management act; the
            // assignee may also do it for their own task.
            canEdit={canManage || task.assignee.id === actor.id}
          />

          <Panel title="Time">
            <Row
              label="Estimate vs actual"
              value={
                <EstimateVsActual
                  estimateMinutes={task.currentEstimateMinutes}
                  actualMinutes={task.actualMinutes}
                />
              }
            />
            {/*
              Original estimate is shown only once it differs. It freezes at
              the first time entry, so a difference means someone re-planned
              mid-flight — worth seeing, and meaningless noise otherwise.
            */}
            {task.originalEstimateMinutes !== null &&
              task.originalEstimateMinutes !== task.currentEstimateMinutes && (
                <Row
                  label="Originally estimated"
                  value={formatMinutes(task.originalEstimateMinutes)}
                />
              )}
            {timeByPerson.length > 0 && (
              <div className="pt-1">
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Logged by
                </div>
                <ul className="mt-1 space-y-0.5">
                  {timeByPerson.map((p) => (
                    <li
                      key={p.userId.toString()}
                      className="flex justify-between text-sm text-slate-700"
                    >
                      <span>{p.name}</span>
                      <span className="tabular">{formatMinutes(p.minutes)}</span>
                    </li>
                  ))}
                </ul>
                {timeByPerson.length > 1 && (
                  <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 text-sm font-medium">
                    <span>Total</span>
                    <span className="tabular">{formatMinutes(totalMinutes)}</span>
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Dates">
            <Row
              label="Due"
              value={
                <DueDate
                  date={task.dueDate}
                  type={task.dueDateType}
                  done={closed}
                  externalLabel={terms.short("externalDeadline")}
                />
              }
            />
            {task.externalDeadline && (
              <Row
                label={terms.t("externalDeadline")}
                value={task.externalDeadline.toISOString().slice(0, 10)}
              />
            )}
            {task.startedAt && <Row label="Started" value={relativeTime(task.startedAt)} />}
            {task.completedAt && (
              <Row label="Completed" value={relativeTime(task.completedAt)} />
            )}
            <Row label="Created" value={relativeTime(task.createdAt)} />
          </Panel>

          <Panel title={terms.t("engagement")}>
            <Row label={terms.t("client")} value={task.engagement.client.name} />
            <Row
              label="Engagement"
              value={`${task.engagement.name}${task.engagement.fy ? ` ${task.engagement.fy}` : ""}`}
            />
            {task.engagement.partner && (
              <Row label="Partner" value={task.engagement.partner.name} />
            )}
            {task.engagement.manager && (
              <Row label="Manager" value={task.engagement.manager.name} />
            )}
          </Panel>

          {task.tags.length > 0 && (
            <Panel title="Tags">
              <div className="flex flex-wrap gap-1.5">
                {task.tags.map(({ tag }) => (
                  <span
                    key={tag.id.toString()}
                    className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {!canManage && (
            <p className="text-xs text-slate-400">
              You can see this {terms.t("task").toLowerCase()} but cannot direct it —
              deadlines, priority and assignment are set by whoever manages the{" "}
              {terms.t("engagement").toLowerCase()}.
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

const TONE_STYLES = {
  neutral: "bg-slate-300",
  notable: "bg-blue-400",
  warning: "bg-amber-500",
  positive: "bg-green-500",
} as const;

function Timeline({
  entries,
  nameOf,
}: {
  entries: ActivityEntry[];
  nameOf: (id: string) => string;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
        No history recorded.
      </p>
    );
  }

  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-5">
      {entries.map((entry) => {
        const { verb, detail, tone } = describeActivity(entry, nameOf);
        return (
          <li key={entry.id.toString()} className="relative">
            <span
              className={`absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full ring-2 ring-white ${TONE_STYLES[tone]}`}
              aria-hidden="true"
            />
            <p className="text-sm text-slate-800">
              <span className="font-medium">{entry.actor.name}</span> {verb}
              {detail && <span className="text-slate-600"> {detail}</span>}
              <span className="ml-2 text-xs text-slate-400">
                {relativeTime(entry.actedAt)}
              </span>
            </p>
            {/*
              The reason, where one was required. This is the answer to "why
              did this happen?" and the whole point of making it mandatory on
              deadline changes, reopens, cancellations and rejections.
            */}
            {entry.reason && (
              <p className="mt-0.5 border-l-2 border-slate-200 pl-2 text-sm italic text-slate-600">
                {entry.reason}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── Small building blocks ───────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="text-right text-slate-900">{value}</span>
    </div>
  );
}
