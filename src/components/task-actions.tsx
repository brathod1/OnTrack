"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { TaskStatus } from "@prisma/client";
import {
  setBlockedAction,
  transitionAction,
  type ActionResult,
} from "@/app/(app)/tasks/[key]/actions";

/**
 * The action bar on a task.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Renders ONLY the transitions the permission kernel returned. It makes no
 * judgement of its own about who may do what — and because every mutation
 * re-checks server-side, a client that ignored this list would gain nothing.
 *
 * Three behaviours worth knowing:
 *
 *   A REASON IS A DIALOG, NOT AN OPTIONAL FIELD. Sending work back, reopening,
 *   cancelling and blocking all require one. An inline box people can skip
 *   produces a history full of unexplained changes, which is the failure this
 *   whole log exists to prevent.
 *
 *   A CONFLICT OFFERS RELOAD, NEVER RETRY. If someone else changed the task
 *   first, retrying would apply your change to a task that may no longer be
 *   the one you were looking at.
 *
 *   WARNINGS ARE SHOWN, NOT ENFORCED. "Completed with no time logged"
 *   succeeds and says so. Blocking it would teach people to log a fake
 *   fifteen minutes, which is worse than the gap it was meant to prevent.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface TransitionOption {
  to: TaskStatus;
  label: string;
  requiresReason: boolean;
}

interface Props {
  taskKey: string;
  version: string;
  transitions: TransitionOption[];
  canManage: boolean;
  isBlocked: boolean;
  blockedReason: string | null;
  /** Blocking a closed task makes no sense; the server refuses it too. */
  canBlock: boolean;
}

export function TaskActions({
  taskKey,
  version,
  transitions,
  canManage,
  isBlocked,
  blockedReason,
  canBlock,
}: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    transitionAction,
    null
  );
  const [blockState, blockFormAction, blockPending] = useActionState<
    ActionResult | null,
    FormData
  >(setBlockedAction, null);

  /** The transition awaiting a reason, if any. */
  const [pendingTransition, setPendingTransition] = useState<TransitionOption | null>(null);
  const [showBlockDialog, setShowBlockDialog] = useState(false);

  /**
   * Which action fired most recently.
   *
   * Two independent `useActionState` hooks each keep their last result for the
   * life of the component. Reading `state ?? blockState` always preferred the
   * transition — so after a failed transition followed by a successful block,
   * the user saw "someone else changed this task" sitting above visible proof
   * that their block had worked.
   */
  const [lastAction, setLastAction] = useState<"transition" | "block" | null>(null);

  /**
   * Whether the user has dismissed the current message.
   *
   * Needed because `useActionState` has no reset: `router.refresh()` re-fetches
   * the page but leaves the hook's last result in place, so a conflict banner
   * survived the very reload it was asking for.
   */
  const [dismissed, setDismissed] = useState(false);

  const result = lastAction === "block" ? blockState : lastAction === "transition" ? state : null;
  const visible = dismissed ? null : result;

  // A new result always deserves to be seen, whatever was dismissed before.
  useEffect(() => setDismissed(false), [state, blockState]);

  useEffect(() => {
    if (state?.ok || blockState?.ok) {
      setPendingTransition(null);
      setShowBlockDialog(false);
      router.refresh();
    }
  }, [state, blockState, router]);

  function reload() {
    setDismissed(true);
    router.refresh();
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {transitions.map((t) => (
          <TransitionButton
            key={t.to}
            option={t}
            taskKey={taskKey}
            version={version}
            canManage={canManage}
            pending={pending}
            onNeedsReason={() => setPendingTransition(t)}
            onSubmit={() => setLastAction("transition")}
            formAction={formAction}
          />
        ))}

        {canBlock && (
          <button
            type="button"
            onClick={() => setShowBlockDialog(true)}
            disabled={blockPending}
            className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
              isBlocked
                ? "border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100"
                : "border-slate-300 hover:bg-slate-100"
            }`}
          >
            {isBlocked ? "Clear block" : "Mark blocked"}
          </button>
        )}
      </div>

      {visible && !visible.ok && visible.error && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p>{visible.error}</p>

          {visible.conflict && (
            <button
              onClick={reload}
              className="mt-2 rounded border border-amber-400 px-2 py-1 text-xs font-medium hover:bg-amber-100"
            >
              Reload the task
            </button>
          )}

          {visible.canOverride && pendingTransition === null && (
            <p className="mt-1 text-xs">
              As a manager you can proceed anyway — reopen the action and tick
              &ldquo;proceed despite open subtasks&rdquo;.
            </p>
          )}
        </div>
      )}

      {visible?.ok && visible.warnings && visible.warnings.length > 0 && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          {visible.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      {pendingTransition && (
        <ReasonDialog
          title={pendingTransition.label}
          taskKey={taskKey}
          version={version}
          canManage={canManage}
          to={pendingTransition.to}
          offerOverride={Boolean(visible?.canOverride)}
          pending={pending}
          formAction={formAction}
          onSubmit={() => setLastAction("transition")}
          onClose={() => setPendingTransition(null)}
        />
      )}

      {showBlockDialog && (
        <BlockDialog
          taskKey={taskKey}
          version={version}
          isBlocked={isBlocked}
          currentReason={blockedReason}
          pending={blockPending}
          formAction={blockFormAction}
          onSubmit={() => setLastAction("block")}
          onClose={() => setShowBlockDialog(false)}
        />
      )}
    </div>
  );
}

/** A transition with no reason requirement submits straight away. */
function TransitionButton({
  option,
  taskKey,
  version,
  canManage,
  pending,
  onNeedsReason,
  onSubmit,
  formAction,
}: {
  option: TransitionOption;
  taskKey: string;
  version: string;
  canManage: boolean;
  pending: boolean;
  onNeedsReason: () => void;
  /** Records which of the two actions fired, so the right result is shown. */
  onSubmit: () => void;
  formAction: (formData: FormData) => void;
}) {
  const destructive = option.to === "CANCELLED";

  if (option.requiresReason) {
    return (
      <button
        type="button"
        onClick={onNeedsReason}
        disabled={pending}
        className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
          destructive
            ? "border-red-300 text-red-700 hover:bg-red-50"
            : "border-slate-300 hover:bg-slate-100"
        }`}
      >
        {option.label}…
      </button>
    );
  }

  return (
    <form action={formAction} onSubmit={onSubmit}>
      <input type="hidden" name="key" value={taskKey} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="to" value={option.to} />
      <input type="hidden" name="canManage" value={String(canManage)} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "Working…" : option.label}
      </button>
    </form>
  );
}

function ReasonDialog({
  title,
  taskKey,
  version,
  to,
  canManage,
  offerOverride,
  pending,
  formAction,
  onSubmit,
  onClose,
}: {
  title: string;
  taskKey: string;
  version: string;
  to: TaskStatus;
  canManage: boolean;
  offerOverride: boolean;
  pending: boolean;
  formAction: (formData: FormData) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <form action={formAction} onSubmit={onSubmit} className="space-y-3">
        <input type="hidden" name="key" value={taskKey} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="to" value={to} />
        <input type="hidden" name="canManage" value={String(canManage)} />

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Reason
          </span>
          <textarea
            name="reason"
            required
            minLength={3}
            rows={3}
            autoFocus
            placeholder="Why is this happening? This is recorded permanently."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-400">
            Shown on the task history to anyone who can see this task.
          </span>
        </label>

        {offerOverride && canManage && (
          <label className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-sm">
            <input type="checkbox" name="override" className="mt-0.5" />
            <span className="text-amber-900">
              Proceed despite open subtasks
              <span className="block text-xs">
                They stay open and are recorded as overridden.
              </span>
            </span>
          </label>
        )}

        <DialogButtons pending={pending} onClose={onClose} confirmLabel={title} />
      </form>
    </Dialog>
  );
}

function BlockDialog({
  taskKey,
  version,
  isBlocked,
  currentReason,
  pending,
  formAction,
  onSubmit,
  onClose,
}: {
  taskKey: string;
  version: string;
  isBlocked: boolean;
  currentReason: string | null;
  pending: boolean;
  formAction: (formData: FormData) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={isBlocked ? "Clear the block" : "Mark blocked"} onClose={onClose}>
      <form action={formAction} onSubmit={onSubmit} className="space-y-3">
        <input type="hidden" name="key" value={taskKey} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="blocked" value={String(!isBlocked)} />

        {isBlocked ? (
          <p className="text-sm text-slate-700">
            Currently blocked: <span className="italic">{currentReason}</span>
          </p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                What is blocking it?
              </span>
              <textarea
                name="reason"
                required
                minLength={3}
                rows={2}
                autoFocus
                placeholder="e.g. awaiting bank statements from the client"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              {/* Blocked with no reason is noise nobody can act on, and the
                  manager view that matters — work stalled more than N days and
                  who is holding it up — needs this half populated. */}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                Expected to clear by <span className="normal-case">(optional)</span>
              </span>
              <input
                type="date"
                name="expectedUnblockDate"
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </>
        )}

        <DialogButtons
          pending={pending}
          onClose={onClose}
          confirmLabel={isBlocked ? "Clear block" : "Mark blocked"}
        />
      </form>
    </Dialog>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-4 pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DialogButtons({
  pending,
  onClose,
  confirmLabel,
}: {
  pending: boolean;
  onClose: () => void;
  confirmLabel: string;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button
        type="button"
        onClick={onClose}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "Working…" : confirmLabel}
      </button>
    </div>
  );
}
