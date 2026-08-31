import type { Metadata } from "next";
import Link from "next/link";
import { requireActingUser } from "@/lib/auth/session";
import {
  BAND_LABELS,
  formatMinutes,
  getMyWork,
  isParent,
  openSubtaskCount,
  type MyWorkTask,
} from "@/lib/tasks/my-work";
import {
  BlockedFlag,
  DueDate,
  EstimateVsActual,
  PriorityMark,
  ReworkFlag,
  StatusBadge,
  SubtaskCount,
} from "@/components/task-ui";
import { QuickCreate } from "@/components/quick-create";
import { getCreateOptions } from "@/lib/tasks/create-options";
import { getTerminology } from "@/lib/org/terminology";

export const metadata: Metadata = { title: "My work" };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * My Work — the screen a staff member opens every morning.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE PRIORITISED LIST, NOT FOUR WIDGETS.
 *
 * The obvious design is separate boxes for Overdue / Due today / Blocked /
 * This week. It looks tidier and is worse: the user has to mentally merge
 * four lists to work out what to do first, every morning, forever. Ordering
 * them once here does that work for them.
 *
 * NOT SHOWN, deliberately: tasks completed this month, a personal chart, any
 * kind of streak. Nobody needs their own scoreboard at 9am, and it invites
 * precisely the gaming the metrics policy exists to prevent.
 * ─────────────────────────────────────────────────────────────────────────
 */
export default async function MyWorkPage() {
  const actor = await requireActingUser();
  const [{ bands, counts, requested }, createOptions, terms] = await Promise.all([
    getMyWork(actor),
    getCreateOptions(actor),
    getTerminology(),
  ]);

  // Resolved once here and threaded down, so the presentational components
  // never reach the database themselves.
  const labels = {
    engagement: terms.t("engagement"),
    externalDeadline: terms.short("externalDeadline"),
    committedDeadline: terms.short("committedDeadline"),
    internalDeadline: terms.short("internalDeadline"),
  };

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">My work</h1>
            <p className="mt-0.5 text-sm text-slate-600">
              {counts.total === 0
                ? "Nothing on your plate."
                : `${counts.total} open ${counts.total === 1 ? "task" : "tasks"}`}
            </p>
          </div>
          <QuickCreate options={createOptions} labels={labels} />
        </div>

        {counts.total > 0 && (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {counts.overdue > 0 && (
              <Metric label="Overdue" value={counts.overdue} tone="text-red-700" />
            )}
            {counts.dueToday > 0 && <Metric label="Due today" value={counts.dueToday} />}
            {counts.awaitingMyReview > 0 && (
              <Metric label="To review" value={counts.awaitingMyReview} />
            )}
            {counts.blocked > 0 && (
              <Metric label="Blocked" value={counts.blocked} tone="text-orange-700" />
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Remaining</dt>
              <dd className="tabular font-semibold text-slate-900">
                {formatMinutes(counts.remainingMinutes)}
                {/* Never present a confident number built on missing data.
                    Showing the gap is what keeps the figure trustworthy. */}
                {counts.unestimated > 0 && (
                  <span
                    className="ml-1.5 text-xs font-normal text-slate-500"
                    title={`${counts.unestimated} of your tasks have no estimate and are not counted`}
                  >
                    + {counts.unestimated} unestimated
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {bands.length === 0 && requested.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-6 space-y-6">
          {bands.map(({ band, tasks }) => (
            <section key={band}>
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-slate-700">
                {BAND_LABELS[band]}
                <span className="tabular text-xs font-normal text-slate-400">{tasks.length}</span>
              </h2>
              <ul className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.displayKey}
                    task={task}
                    currentUserId={actor.id}
                    externalLabel={labels.externalDeadline}
                  />
                ))}
              </ul>
            </section>
          ))}

          {/* BELOW the bands, and separated from them, because this is not
              your to-do list. Above it is what you must do; this is what you
              are waiting on. Mixed into the priority order it would compete
              with your own overdue work for attention it has not earned —
              somebody else is already accountable for every row here. */}
          {requested.length > 0 && (
            <section className="border-t border-slate-200 pt-6">
              <h2 className="mb-1 flex items-baseline gap-2 text-sm font-semibold text-slate-700">
                Waiting on someone else
                <span className="tabular text-xs font-normal text-slate-400">
                  {requested.length}
                </span>
              </h2>
              <p className="mb-2 text-xs text-slate-500">
                Work you asked for. Not counted in your own workload above.
              </p>
              <ul className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                {requested.map((task) => (
                  <TaskRow
                    key={task.displayKey}
                    task={task}
                    currentUserId={actor.id}
                    externalLabel={labels.externalDeadline}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

/**
 * Why someone else's task is on your screen, and who has it.
 *
 * Checked in the order the relationships actually override one another:
 * reviewing or contributing is an active job on the task and outranks having
 * asked for it, so somebody who created a task AND reviews it is told the
 * thing they have to act on.
 *
 * The requester case reads "waiting on Divya Menon" rather than following the
 * "<relationship> · <name>" shape of the other two. That shape works when the
 * name is plainly the person doing the work — "you review · Divya Menon" — and
 * breaks when it isn't: "you asked for this · Divya Menon" was read on the
 * real screen as DIVYA having asked, which is the exact opposite of the truth.
 * A phrase that names the person inside it cannot be parsed backwards.
 */
function relationshipLabel(task: MyWorkTask, currentUserId: bigint): string {
  const who = task.assignee.name;
  if (task.reviewerId === currentUserId) return `you review · ${who}`;
  if (task.contributors.some((c) => c.userId === currentUserId)) {
    return `you contribute · ${who}`;
  }
  if (task.createdById === currentUserId) return `waiting on ${who}`;
  return `you contribute · ${who}`;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`tabular font-semibold ${tone ?? "text-slate-900"}`}>{value}</dd>
    </div>
  );
}

/**
 * One task row.
 *
 * Responsive without a separate mobile component: the row is a flex column
 * below `sm` and a row above it. Two components would drift apart, and this is
 * one of the screens people genuinely open on a phone — in a client's
 * reception, between meetings.
 */
function TaskRow({
  task,
  currentUserId,
  externalLabel,
}: {
  task: MyWorkTask;
  currentUserId: bigint;
  externalLabel: string;
}) {
  const mine = task.assigneeId === currentUserId;
  const isSubtask = task.parentTaskId !== null;
  const parent = isParent(task);

  // The roll-up across children, shown on the parent for context. It is
  // NOT part of the capacity figure at the top of the page — that counts leaf
  // tasks only, or this work would be counted twice.
  const rollUpEstimate = parent
    ? task.subtasks.reduce((sum, s) => sum + (s.currentEstimateMinutes ?? 0), 0)
    : 0;

  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <Link
        href={`/tasks/${task.displayKey}`}
        // FLAT. Subtasks were indented behind a left rule, and it read as a
        // lie: a rule down the side of consecutive rows is the standard visual
        // for "these belong to the row above", but this list is sorted by DATE,
        // so the row above is usually unrelated — and the actual parent is
        // frequently not in the list at all, being someone else's work.
        //
        // The "part of X" label below states the relationship exactly and
        // survives any sort order. Nothing is lost by dropping the rule except
        // an implication that was false.
        className="flex flex-col gap-1.5 py-2.5 pl-3 pr-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3"
      >
        <PriorityMark priority={task.priority} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-slate-900">{task.title}</span>
            {task.isBlocked && <BlockedFlag reason={task.blockedReason} />}
            <ReworkFlag round={task.reviewRound} />
            <SubtaskCount open={openSubtaskCount(task)} />
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span className="tabular">{task.displayKey}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">
              {task.engagement.client.code} — {task.engagement.name}
            </span>

            {/* What this subtask is part of — now the ONLY signal of
                hierarchy, so it is no longer the faintest thing on the row. */}
            {isSubtask && task.parentTask && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate text-slate-500">
                  part of {task.parentTask.title}
                </span>
              </>
            )}

            {/* Why this task is on your screen, when it isn't yours. Without
                it, a reviewer wonders why someone else's work is in their list.

                Three reasons, not two. "You contribute" was the catch-all for
                anything that was not yours and not yours to review, which was
                true until requested work reached this screen — a requester
                contributes nothing, and telling them they do misdescribes what
                they may actually DO with the row. */}
            {!mine && (
              <>
                <span aria-hidden="true">·</span>
                <span className="italic">{relationshipLabel(task, currentUserId)}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          {parent ? (
            // A parent shows its children's total instead of its own numbers,
            // and says so — otherwise the row looks like it has a suspiciously
            // small estimate for a large piece of work.
            <span
              className="tabular whitespace-nowrap text-sm text-slate-500"
              title="Total estimated across subtasks. Not counted again in your remaining hours."
            >
              {formatMinutes(rollUpEstimate)} across subtasks
            </span>
          ) : (
            <EstimateVsActual
              estimateMinutes={task.currentEstimateMinutes}
              actualMinutes={task.actualMinutes}
            />
          )}
          <StatusBadge status={task.status} />
          <div className="w-24 text-right sm:w-28">
            <DueDate
              date={task.dueDate}
              type={task.dueDateType}
              externalLabel={externalLabel}
            />
          </div>
        </div>
      </Link>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="mt-8 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="font-medium text-slate-900">Nothing assigned to you.</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
        Work assigned to you, tasks you contribute to, and anything waiting for
        your review will appear here.
      </p>
    </div>
  );
}
