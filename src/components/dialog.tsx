"use client";

import { useEffect } from "react";

/**
 * The modal used for anything that needs a reason or a confirmation.
 *
 * Extracted from the task action bar when the timer needed the same thing.
 * Kept deliberately plain: Escape closes, a backdrop click closes, and the
 * confirm button disables while the action is in flight. No animation, no
 * focus trap library, no portal — this is an internal tool and every
 * dependency here is one somebody has to keep patched for a decade.
 *
 * `autoFocus` on the first field inside is the caller's job, because only the
 * caller knows which field that is.
 */
export function Dialog({
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

export function DialogButtons({
  pending,
  onClose,
  confirmLabel,
  destructive = false,
}: {
  pending: boolean;
  onClose: () => void;
  confirmLabel: string;
  destructive?: boolean;
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
        className={`rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
          destructive ? "bg-red-600 hover:bg-red-700" : "bg-slate-900 hover:bg-slate-800"
        }`}
      >
        {pending ? "Working…" : confirmLabel}
      </button>
    </div>
  );
}
