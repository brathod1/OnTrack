"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatElapsed } from "@/lib/time/duration";
import { stopTimerAction, type TimeActionResult } from "@/lib/time/actions";

/**
 * The running timer, visible from every page.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT IS IN THE HEADER AT ALL: a timer you have to go and find is a timer
 * left running. The forgotten-timer problem is mostly an out-of-sight problem,
 * and the cheapest fix is that the clock is never out of sight.
 *
 * WHAT IT DELIBERATELY CANNOT DO: stop a timer that has run past eight hours.
 * That case requires a note, and a header is the wrong place for a textarea —
 * so it links to the task instead. The rule stays in the service; this just
 * declines to offer a button that would fail.
 *
 * When nothing is running it renders nothing. An always-present "no timer"
 * chip is noise on every page for the sake of a state the user already knows.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface HeaderTimerProps {
  running: {
    taskId: string;
    taskKey: string;
    taskTitle: string;
    startedAt: string;
    isSuspended: boolean;
  } | null;
  serverNow: string;
}

export function HeaderTimer({ running, serverNow }: HeaderTimerProps) {
  const router = useRouter();
  const [state, action, pending] = useActionState<TimeActionResult | null, FormData>(
    stopTimerAction,
    null
  );

  const offset = useMemo(() => Date.now() - new Date(serverNow).getTime(), [serverNow]);
  const [now, setNow] = useState(() => Date.now());

  const live = running !== null && !running.isSuspended;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  if (!running) return null;

  if (running.isSuspended) {
    return (
      <Link
        href={`/tasks/${running.taskKey}`}
        className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-sm text-amber-900 hover:bg-amber-100"
        title="A timer was left running and is waiting to be confirmed"
      >
        <span aria-hidden>⚠</span>
        <span className="hidden sm:inline">Confirm timer</span>
        <span className="font-medium">{running.taskKey}</span>
      </Link>
    );
  }

  const elapsedMs = Math.max(0, now - offset - new Date(running.startedAt).getTime());
  const needsNote = elapsedMs > 8 * 3_600_000;

  return (
    <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1">
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-emerald-600"
        aria-hidden
      />
      <Link
        href={`/tasks/${running.taskKey}`}
        className="hidden max-w-[16ch] truncate text-sm text-emerald-900 hover:underline sm:inline"
        title={running.taskTitle}
      >
        {running.taskKey}
      </Link>
      <span className="font-mono text-sm tabular-nums text-emerald-900">
        {formatElapsed(elapsedMs)}
      </span>

      {needsNote ? (
        // Stopping this needs a note, and a header is the wrong place for one.
        <Link
          href={`/tasks/${running.taskKey}`}
          className="rounded border border-emerald-600 px-1.5 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
        >
          Stop…
        </Link>
      ) : (
        <form action={action}>
          <input type="hidden" name="key" value={running.taskKey} />
          <input type="hidden" name="taskId" value={running.taskId} />
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-emerald-600 px-1.5 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            {pending ? "…" : "Stop"}
          </button>
        </form>
      )}
    </div>
  );
}
