"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createTaskAction, type CreateTaskResult } from "@/app/(app)/tasks/actions";
import type { CreateOptions } from "@/lib/tasks/create-options";

/**
 * Quick create.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SCREEN THAT DECIDES ADOPTION.
 *
 * Everything else in this system is irrelevant if a manager finds it faster to
 * send a WhatsApp message. So: four fields visible — title, engagement,
 * assignee, due date — and everything else folded behind "More". Opens on N,
 * submits on Ctrl+Enter, stays open for the next one.
 *
 * The assignee list shows each person's CURRENT LOAD. That is the detail that
 * changes behaviour: overload becomes visible while the decision is being
 * made, not in a report next week once the work has already landed.
 * ─────────────────────────────────────────────────────────────────────────
 */

function formatLoad(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = Math.round(minutes / 60);
  return `${h}h`;
}

/** Today + n days as YYYY-MM-DD, for the date input's default. */
function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function QuickCreate({ options }: { options: CreateOptions }) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  /**
   * The confirmation is LOCAL state, not read from the action result.
   *
   * `useActionState` keeps its last result for the life of the component, so
   * rendering the banner straight from it meant reopening the dialog an hour
   * later still showed "Created TSK-2026-00027 — add another", which is stale
   * advice about a task you have long since forgotten.
   */
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const [state, formAction, pending] = useActionState<CreateTaskResult | null, FormData>(
    createTaskAction,
    null
  );
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const canCreate = options.engagements.length > 0;

  /**
   * Opening and closing reset the dialog to its four-field default.
   *
   * Anything the user expanded, and any message from last time, belongs to
   * that session. Carrying it forward means the "quick" form greets the next
   * task fully expanded — which defeats the point of hiding those fields.
   */
  function openDialog() {
    setShowMore(false);
    setCreatedKey(null);
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    setShowMore(false);
    setCreatedKey(null);
  }

  // Keyboard: N opens the form. Ignored while typing, so pressing "n" in a
  // search box doesn't spawn a dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable;

      if (!open && !typing && e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openDialog();
      }
      if (open && e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  /**
   * After a successful create, clear the form but KEEP IT OPEN, and keep the
   * engagement and assignee selected.
   *
   * Managers create tasks in runs — twenty GST tasks for one engagement, then
   * twenty audit tasks. Closing the dialog after each one, and making them
   * re-pick the same engagement twenty times, is how a 25-second interaction
   * becomes a two-minute one and people stop bothering.
   */
  useEffect(() => {
    if (state?.ok && state.created && formRef.current) {
      const form = formRef.current;
      (form.elements.namedItem("title") as HTMLInputElement).value = "";
      const notes = form.elements.namedItem("description") as HTMLTextAreaElement | null;
      if (notes) notes.value = "";

      setCreatedKey(state.created.key);
      titleRef.current?.focus();
      router.refresh();
    }
  }, [state, router]);

  if (!canCreate) return null;

  return (
    <>
      <button
        onClick={openDialog}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
      >
        New task
        <kbd className="ml-2 rounded border border-slate-600 px-1 text-[10px] font-normal text-slate-300">
          N
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-4 pt-[8vh]"
          onClick={(e) => e.target === e.currentTarget && closeDialog()}
          role="dialog"
          aria-modal="true"
          aria-label="New task"
        >
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <form
              ref={formRef}
              action={formAction}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter submits from anywhere in the form, including
                // the description textarea where Enter means newline.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
            >
              <div className="space-y-3 p-4">
                {state?.formError && (
                  <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {state.formError}
                  </p>
                )}

                {createdKey && (
                  <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                    Created <span className="tabular font-medium">{createdKey}</span>. Add
                    another, or press Escape to close.
                  </p>
                )}

                <Field label="Task" error={state?.fieldErrors?.title}>
                  <input
                    ref={titleRef}
                    name="title"
                    required
                    maxLength={200}
                    placeholder="e.g. GSTR-3B for August"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500"
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Engagement" error={state?.fieldErrors?.engagementId}>
                    <select
                      name="engagementId"
                      required
                      defaultValue={options.engagements[0]?.id}
                      className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                    >
                      {options.engagements.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.clientCode} — {e.label}
                          {e.recentlyUsed ? " ·" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Due" error={state?.fieldErrors?.dueDate}>
                    <input
                      type="date"
                      name="dueDate"
                      required
                      defaultValue={isoDate(7)}
                      min={isoDate(-365)}
                      className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                    />
                  </Field>
                </div>

                <Field
                  label="Assign to"
                  error={state?.fieldErrors?.assigneeId}
                  hint="Current open work is shown beside each name"
                >
                  <select
                    name="assigneeId"
                    required
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                  >
                    <option value="">Choose someone…</option>
                    {options.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.teamName ? ` (${p.teamName})` : ""} — {p.openTasks} open,{" "}
                        {formatLoad(p.remainingMinutes)} left
                        {p.overdueTasks > 0 ? `, ${p.overdueTasks} overdue` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* A toggle, not a one-way door. Expanding was reversible in
                    every other form the user has ever used; making it one-way
                    here means the only way back is closing the dialog. */}
                <button
                  type="button"
                  onClick={() => setShowMore((v) => !v)}
                  aria-expanded={showMore}
                  className="text-sm text-slate-500 underline underline-offset-2 hover:text-slate-800"
                >
                  {showMore ? "Fewer options" : "More options"}
                </button>

                {showMore && (
                  <div className="space-y-3 rounded-md bg-slate-50 p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Priority">
                        <select
                          name="priority"
                          defaultValue="NORMAL"
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        >
                          <option value="CRITICAL">Critical</option>
                          <option value="HIGH">High</option>
                          <option value="NORMAL">Normal</option>
                          <option value="LOW">Low</option>
                        </select>
                      </Field>

                      <Field label="Estimate (hours)" error={state?.fieldErrors?.estimateMinutes}>
                        <input
                          type="number"
                          name="estimateHours"
                          step="0.25"
                          min="0"
                          placeholder="e.g. 3"
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        />
                      </Field>

                      <Field label="Deadline type">
                        <select
                          name="dueDateType"
                          defaultValue="INTERNAL"
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        >
                          <option value="INTERNAL">Internal</option>
                          <option value="CLIENT_COMMITTED">Client committed</option>
                          <option value="STATUTORY">Statutory</option>
                        </select>
                      </Field>
                    </div>

                    <Field label="Reviewer" error={state?.fieldErrors?.reviewerId}>
                      <select
                        name="reviewerId"
                        defaultValue=""
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      >
                        <option value="">Decide later</option>
                        {options.people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field label="Notes">
                      <textarea
                        name="description"
                        rows={3}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </Field>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                <span className="text-xs text-slate-400">Ctrl + Enter to save</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {pending ? "Creating…" : "Create task"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
      {/* Errors sit under their own field, never in a summary at the top —
          a list of messages at the top makes the user hunt for which input
          each one refers to. */}
      {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
      {!error && hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
