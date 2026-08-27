"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogButtons } from "@/components/dialog";
import { DurationParseError, formatDuration, formatElapsed, parseDuration } from "@/lib/time/duration";
import {
  discardTimerAction,
  editTimeAction,
  logTimeAction,
  startTimerAction,
  stopTimerAction,
  type TimeActionResult,
} from "@/lib/time/actions";

/**
 * The timer control and manual entry panel on a task.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ELAPSED READOUT IS DERIVED FROM THE SERVER'S CLOCK, NOT THE BROWSER'S.
 *
 * The server sends `startedAt` and its own `now` in the same response. The
 * difference between that `now` and the browser's is the offset, measured
 * once at mount and applied to every tick. Without it, a laptop whose clock
 * is four minutes fast shows a timer four minutes ahead of what will actually
 * be recorded — and the user believes the display, not the ledger.
 *
 * The readout is DISPLAY ONLY. Duration is computed server-side on stop, from
 * the stored `startedAt`. Nothing this component renders can influence it.
 *
 * SWITCHING TIMERS IS CONFIRMED, NEVER SILENT. Starting a timer while another
 * runs stops the first. That is the right behaviour — two timers means double
 * counting — but it must be stated before it happens, naming the task that
 * will stop, because otherwise a misclick quietly ends an hour of tracking.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface RunningTimer {
  entryId: string;
  taskKey: string;
  taskTitle: string;
  /** ISO 8601, from the server. */
  startedAt: string;
  /**
   * The watchdog paused this one for running past the ceiling. It still holds
   * the timer slot, but no time is recorded and none will be until its owner
   * says how long they actually worked.
   */
  isSuspended: boolean;
}

interface Props {
  taskKey: string;
  taskId: string;
  /** The user's running timer, wherever it is. Null if none. */
  running: RunningTimer | null;
  /** The server's clock at render, ISO 8601. Corrects for browser drift. */
  serverNow: string;
  /** Today, as the ORGANISATION reckons it. Not the browser's idea of today. */
  todayIso: string;
  canLogTime: boolean;
  actualMinutes: number;
  estimateMinutes: number | null;
}

export function TaskTimer({
  taskKey,
  taskId,
  running,
  serverNow,
  todayIso,
  canLogTime,
  actualMinutes,
  estimateMinutes,
}: Props) {
  const router = useRouter();

  const [startState, startAction, startPending] = useActionState<
    TimeActionResult | null,
    FormData
  >(startTimerAction, null);
  const [stopState, stopAction, stopPending] = useActionState<TimeActionResult | null, FormData>(
    stopTimerAction,
    null
  );
  const [discardState, discardAction, discardPending] = useActionState<
    TimeActionResult | null,
    FormData
  >(discardTimerAction, null);

  const [dialog, setDialog] = useState<"switch" | "stopNote" | "discard" | "log" | null>(null);
  const [lastAction, setLastAction] = useState<"start" | "stop" | "discard" | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const runningHere = running?.taskKey === taskKey;
  const suspendedHere = runningHere && running!.isSuspended;

  const result =
    lastAction === "start" ? startState : lastAction === "stop" ? stopState : lastAction === "discard" ? discardState : null;
  const visible = dismissed ? null : result;

  useEffect(() => setDismissed(false), [startState, stopState, discardState]);

  useEffect(() => {
    if (startState?.ok || stopState?.ok || discardState?.ok) {
      setDialog(null);
      router.refresh();
      announceTimerChange();
    }
  }, [startState, stopState, discardState, router]);

  // Other tabs showing other tasks are now stale. The server refuses to act on
  // their stale belief, so this is only about not showing a wrong picture.
  useTimerChangeListener(() => router.refresh());

  // A suspended timer gets no live counter. Ticking upward from a start time
  // fourteen hours ago would present a number that is not going to be recorded
  // and that the user might reasonably believe.
  const elapsedMs = useLiveElapsed(
    runningHere && !suspendedHere ? running!.startedAt : null,
    serverNow
  );

  // Past eight hours the server demands a note, so ask for it in the same
  // click rather than letting the stop fail and making them press it twice.
  const needsNoteToStop = elapsedMs > 8 * 3_600_000;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Time</h2>
        <p className="text-xs text-slate-500">
          {formatDuration(actualMinutes)} logged
          {estimateMinutes ? ` of ${formatDuration(estimateMinutes)} estimated` : ""}
        </p>
      </div>

      {!canLogTime ? (
        <p className="mt-3 text-sm text-slate-500">
          You can see this task but are not working on it, so you cannot log time against it.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {suspendedHere ? (
            <ResolveSuspended
              taskKey={taskKey}
              entryId={running!.entryId}
              startedAt={running!.startedAt}
              onDone={() => router.refresh()}
            />
          ) : runningHere ? (
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="font-mono text-2xl tabular-nums text-slate-900"
                aria-live="off"
                aria-label="Time elapsed on the running timer"
              >
                {formatElapsed(elapsedMs)}
              </span>

              <form
                action={stopAction}
                onSubmit={() => setLastAction("stop")}
                className={needsNoteToStop ? "hidden" : undefined}
              >
                <input type="hidden" name="key" value={taskKey} />
                {/* What this page believes. The server refuses if the timer
                    has moved on — see StopTimerInput. */}
                <input type="hidden" name="taskId" value={taskId} />
                <button
                  type="submit"
                  disabled={stopPending}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {stopPending ? "Stopping…" : "Stop timer"}
                </button>
              </form>

              {needsNoteToStop && (
                <button
                  type="button"
                  onClick={() => setDialog("stopNote")}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Stop timer…
                </button>
              )}

              <button
                type="button"
                onClick={() => setDialog("discard")}
                className="text-sm text-slate-500 underline hover:text-slate-700"
              >
                Discard
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <form
                action={startAction}
                onSubmit={(e) => {
                  // Another timer is running elsewhere: confirm before stopping it.
                  if (running) {
                    e.preventDefault();
                    setDialog("switch");
                    return;
                  }
                  setLastAction("start");
                }}
              >
                <input type="hidden" name="key" value={taskKey} />
                <input type="hidden" name="taskId" value={taskId} />
                <button
                  type="submit"
                  disabled={startPending}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {startPending ? "Starting…" : "Start timer"}
                </button>
              </form>

              <button
                type="button"
                onClick={() => setDialog("log")}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Log time…
              </button>

              {running && (
                <p className="text-xs text-slate-500">
                  A timer is running on{" "}
                  <span className="font-medium text-slate-700">{running.taskKey}</span>.
                </p>
              )}
            </div>
          )}

          {visible && !visible.ok && visible.error && (
            <p
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {visible.error}
            </p>
          )}

          {visible?.ok && visible.stoppedOther && (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              Stopped your timer on {visible.stoppedOther.taskKey} and recorded{" "}
              {formatDuration(visible.stoppedOther.minutes)}.
            </p>
          )}
        </div>
      )}

      {dialog === "switch" && running && (
        <Dialog title="Switch the timer to this task?" onClose={() => setDialog(null)}>
          <form
            action={startAction}
            onSubmit={() => setLastAction("start")}
            className="space-y-3"
          >
            <input type="hidden" name="key" value={taskKey} />
            <input type="hidden" name="taskId" value={taskId} />

            <p className="text-sm text-slate-700">
              Your timer on <span className="font-medium">{running.taskKey}</span> —{" "}
              {running.taskTitle} — will stop and the time so far will be recorded against it.
            </p>

            <DialogButtons
              pending={startPending}
              onClose={() => setDialog(null)}
              confirmLabel="Switch timer"
            />
          </form>
        </Dialog>
      )}

      {dialog === "stopNote" && (
        <Dialog title="Stop the timer" onClose={() => setDialog(null)}>
          <form action={stopAction} onSubmit={() => setLastAction("stop")} className="space-y-3">
            <input type="hidden" name="key" value={taskKey} />
            <input type="hidden" name="taskId" value={taskId} />

            <p className="text-sm text-slate-700">
              This timer has run for {formatElapsed(elapsedMs)}. Describe the work before it is
              recorded.
            </p>

            <textarea
              name="note"
              required
              minLength={3}
              rows={3}
              autoFocus
              placeholder="e.g. full day at client premises reconstructing the purchase ledger"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />

            <DialogButtons
              pending={stopPending}
              onClose={() => setDialog(null)}
              confirmLabel="Stop and record"
            />
          </form>
        </Dialog>
      )}

      {dialog === "discard" && (
        <Dialog title="Discard this timer" onClose={() => setDialog(null)}>
          <form
            action={discardAction}
            onSubmit={() => setLastAction("discard")}
            className="space-y-3"
          >
            <input type="hidden" name="key" value={taskKey} />
            <input type="hidden" name="taskId" value={taskId} />

            <p className="text-sm text-slate-700">
              No time will be recorded. The discarded timer stays in the history with your
              reason — it is not erased.
            </p>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Why?
              </span>
              <input
                name="reason"
                required
                minLength={3}
                autoFocus
                defaultValue="started on the wrong task"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <DialogButtons
              pending={discardPending}
              onClose={() => setDialog(null)}
              confirmLabel="Discard"
              destructive
            />
          </form>
        </Dialog>
      )}

      {dialog === "log" && (
        <LogTimeDialog
          taskKey={taskKey}
          taskId={taskId}
          todayIso={todayIso}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * A timer the watchdog paused, waiting to be told what it was worth.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Deliberately NOT prefilled with the elapsed time. Offering "13h 47m" as a
 * default gets it accepted with one click by someone in a hurry, which
 * reintroduces exactly the fabricated number the watchdog refused to write.
 * The field starts empty and the person has to think for a moment.
 *
 * The start time is shown because it is real evidence and genuinely helps
 * ("I started at nine, so about three hours"). The end time is not shown,
 * because there isn't one — that is the whole problem.
 * ─────────────────────────────────────────────────────────────────────────
 */
function ResolveSuspended({
  taskKey,
  entryId,
  startedAt,
  onDone,
}: {
  taskKey: string;
  entryId: string;
  startedAt: string;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<TimeActionResult | null, FormData>(
    editTimeAction,
    null
  );

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  const started = new Date(startedAt);

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">This timer was left running.</p>
      <p className="mt-1 text-xs text-amber-800">
        It started at{" "}
        <span className="font-medium">
          {started.toLocaleString(undefined, {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>{" "}
        and was never stopped, so nothing has been recorded. How long did you actually work?
      </p>

      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="key" value={taskKey} />
        <input type="hidden" name="entryId" value={entryId} />

        <DurationField label="Time actually worked" />

        <textarea
          name="note"
          rows={2}
          placeholder="Note (optional)"
          className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm"
        />

        {state && !state.ok && state.error && (
          <p role="alert" className="text-sm text-amber-900">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {pending ? "Recording…" : "Record this time"}
        </button>
      </form>
    </div>
  );
}

/**
 * Telling this browser's other tabs that the timer moved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Only cosmetic, and deliberately so. The correctness guarantee is server-side
 * (`expectedTaskId`), which refuses a stale tab's stop rather than trusting
 * this to have arrived. BroadcastChannel does not reach a second browser, a
 * second device, or a tab that was asleep — so it can never be the thing a
 * correct outcome depends on.
 *
 * Guarded because BroadcastChannel does not exist during server rendering, and
 * is missing in a few older or locked-down browsers. A firm on managed
 * desktops will meet at least one.
 * ─────────────────────────────────────────────────────────────────────────
 */
const TIMER_CHANNEL = "ontrack:timer";

function announceTimerChange() {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(TIMER_CHANNEL);
    ch.postMessage("changed");
    ch.close();
  } catch {
    // A refresh that does not happen is not worth an error.
  }
}

function useTimerChangeListener(onChange: () => void) {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    let ch: BroadcastChannel;
    try {
      ch = new BroadcastChannel(TIMER_CHANNEL);
    } catch {
      return;
    }
    ch.onmessage = () => onChange();
    return () => ch.close();
    // onChange is a fresh closure each render; the listener only calls
    // router.refresh(), so rebinding it every render would be churn for
    // nothing. Bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Elapsed milliseconds, corrected for a wrong browser clock.
 *
 * The offset is measured ONCE at mount and then held. Re-measuring on every
 * render would make the readout jitter, and the offset does not change.
 */
function useLiveElapsed(startedAt: string | null, serverNow: string): number {
  const offset = useMemo(() => Date.now() - new Date(serverNow).getTime(), [serverNow]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) return 0;
  return Math.max(0, now - offset - new Date(startedAt).getTime());
}

/** Manual entry. First-class, not a fallback — see the service for why. */
function LogTimeDialog({
  taskKey,
  taskId,
  todayIso,
  onClose,
  onDone,
}: {
  taskKey: string;
  taskId: string;
  todayIso: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<TimeActionResult | null, FormData>(
    logTimeAction,
    null
  );

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <Dialog title="Log time" onClose={onClose}>
      <form action={action} className="space-y-3">
        <input type="hidden" name="key" value={taskKey} />
        <input type="hidden" name="taskId" value={taskId} />

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Date
          </span>
          <input
            type="date"
            name="workDate"
            required
            defaultValue={todayIso}
            max={todayIso}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <DurationField />

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Note <span className="normal-case text-slate-400">(required over 8 hours)</span>
          </span>
          <textarea
            name="note"
            rows={2}
            placeholder="What did you do?"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {state && !state.ok && state.error && (
          <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {state.error}
          </p>
        )}

        <DialogButtons pending={pending} onClose={onClose} confirmLabel="Log time" />
      </form>
    </Dialog>
  );
}

/**
 * A duration field that echoes back what it understood.
 *
 * THE ECHO IS THE POINT, not decoration. A bare number is read as HOURS, so
 * someone who means "45 minutes" and types "45" would otherwise silently
 * record most of a working week. Showing "45h 0m" under the box as they type
 * makes the misreading visible at the moment it happens, which no amount of
 * server-side validation can do — five hours is a perfectly plausible entry.
 */
export function DurationField({
  name = "duration",
  defaultValue = "",
  label = "How long?",
}: {
  name?: string;
  defaultValue?: string;
  label?: string;
}) {
  const [raw, setRaw] = useState(defaultValue);

  const echo = useMemo(() => {
    if (!raw.trim()) return null;
    try {
      return { ok: true as const, text: formatDuration(parseDuration(raw)) };
    } catch (e) {
      return {
        ok: false as const,
        text: e instanceof DurationParseError ? e.message : "not a length of time",
      };
    }
  }, [raw]);

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        name={name}
        required
        autoFocus
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="1h 30m"
        aria-describedby={`${name}-echo`}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <span
        id={`${name}-echo`}
        aria-live="polite"
        className={`mt-1 block text-xs ${
          echo === null ? "text-slate-400" : echo.ok ? "text-slate-600" : "text-amber-700"
        }`}
      >
        {echo === null
          ? "Type 1h 30m, 1:30, 90m or 1.5. A plain number means hours."
          : echo.ok
            ? `Recording ${echo.text}`
            : echo.text}
      </span>
    </label>
  );
}
