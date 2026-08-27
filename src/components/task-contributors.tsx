"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addContributorAction,
  removeContributorAction,
  type ActionResult,
} from "@/app/(app)/tasks/[key]/actions";

/**
 * Contributors — the second half of "one accountable owner plus contributors".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A contributor may log time and comment. They may NOT change status, dates,
 * priority or the assignee. That preserves a single answer to "who is
 * responsible for this?" while still capturing the real effort — including a
 * reviewer's, which would otherwise be invisible in every report.
 *
 * The panel says so out loud, because the distinction is the thing people get
 * wrong: adding someone here is not sharing ownership, it is recording that
 * they worked on it.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface ContributorView {
  id: string;
  name: string;
  addedBy: string;
}

export function TaskContributors({
  taskKey,
  contributors,
  candidates,
  canEdit,
}: {
  taskKey: string;
  contributors: ContributorView[];
  candidates: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const [addState, addAction, addPending] = useActionState<ActionResult | null, FormData>(
    addContributorAction,
    null
  );
  const [removeState, removeAction, removePending] = useActionState<
    ActionResult | null,
    FormData
  >(removeContributorAction, null);

  useEffect(() => {
    if (addState?.ok || removeState?.ok) {
      setAdding(false);
      router.refresh();
    }
  }, [addState, removeState, router]);

  const error = addState?.error ?? removeState?.error;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Contributors
      </h2>

      {contributors.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nobody else is logging time to this.
        </p>
      ) : (
        <ul className="space-y-1">
          {contributors.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-900" title={`Added by ${c.addedBy}`}>
                {c.name}
              </span>
              {canEdit && (
                <form action={removeAction}>
                  <input type="hidden" name="key" value={taskKey} />
                  <input type="hidden" name="userId" value={c.id} />
                  <button
                    type="submit"
                    disabled={removePending}
                    className="text-xs text-slate-400 hover:text-red-700 disabled:opacity-50"
                    title="Remove. Any time they have logged stays with them."
                  >
                    Remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {canEdit && (
        <div className="mt-3">
          {adding ? (
            <form action={addAction} className="space-y-2">
              <input type="hidden" name="key" value={taskKey} />
              <select
                name="userId"
                required
                defaultValue=""
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Choose someone…
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addPending || candidates.length === 0}
                  className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <p className="text-xs text-slate-400">
                They can log time and comment. They cannot change status,
                dates or who it is assigned to.
              </p>
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              disabled={candidates.length === 0}
              className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-900 disabled:no-underline disabled:opacity-50"
            >
              {candidates.length === 0 ? "Nobody left to add" : "Add a contributor"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
