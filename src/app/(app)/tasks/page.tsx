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
  const [{ bands, counts }, createOptions] = await Promise.all([
    getMyWork(actor),
    getCreateOptions(actor),
  ]);

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
          <QuickCreate options={createOptions} />
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

      {bands.length === 0 ? (
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
                  <TaskRow key={task.displayKey} task={task} currentUserId={actor.id} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
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
function TaskRow({ task, currentUserId }: { task: MyWorkTask; currentUserId: bigint }) {
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
        className={`flex flex-col gap-1.5 py-2.5 pr-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3 ${
          // Subtasks are indented and given a left rule so the hierarchy is
          // visible even when the parent is in a different band — which
          // happens often, since a subtask can be due weeks before its parent.
          isSubtask ? "border-l-2 border-slate-200 pl-5" : "pl-3"
        }`}
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

            {/* What this subtask is part of. Without it, a subtask sitting
                three rows above its own parent reads as an unrelated task. */}
            {isSubtask && task.parentTask && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate text-slate-400">
                  part of {task.parentTask.title}
                </span>
              </>
            )}

            {/* Why this task is on your screen, when it isn't yours. Without
                it, a reviewer wonders why someone else's work is in their list. */}
            {!mine && (
              <>
                <span aria-hidden="true">·</span>
                <span className="italic">
                  {task.reviewerId === currentUserId ? "you review" : "you contribute"} ·{" "}
                  {task.assignee.name}
                </span>
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
            <DueDate date={task.dueDate} type={task.dueDateType} />
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
