"use client";

import { useEffect } from "react";

/**
 * Error boundary for every page in the app.
 *
 * Shows a message and a retry. Never a stack trace, never a database error —
 * those go to the server log. In production `error.message` is already
 * scrubbed by Next.js, but relying on that alone would mean development and
 * production behave differently in exactly the situation where you least want
 * a surprise.
 *
 * The digest is displayed because it is the only thing that connects what the
 * user saw to what the server logged. Without it, "it broke" is unanswerable.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] render error:", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-600">
        This page could not be loaded. The error has been logged.
      </p>

      {error.digest && (
        <p className="tabular mt-4 text-xs text-slate-400">
          Reference: {error.digest}
        </p>
      )}

      <div className="mt-6 flex justify-center gap-3">
        <button
          onClick={reset}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
        <a
          href="/tasks"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Back to my work
        </a>
      </div>
    </main>
  );
}
