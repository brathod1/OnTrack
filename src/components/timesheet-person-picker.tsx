"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * Choosing whose timesheet to look at.
 *
 * Navigates on change rather than waiting for a Show button. A manager checking
 * three people's weeks otherwise pays two clicks per person for a control that
 * has exactly one purpose, and the button adds nothing — there is no partial
 * state worth confirming.
 *
 * The <noscript> fallback keeps the button for anyone without JavaScript, so
 * the page never becomes unusable rather than merely less convenient.
 */
export function TimesheetPersonPicker({
  subjects,
  selectedId,
  weekStart,
}: {
  subjects: { id: string; name: string }[];
  /** Empty string means the viewer's own sheet. */
  selectedId: string;
  weekStart: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      action="/timesheet"
      method="get"
      className="flex items-center gap-2"
      // With JavaScript, onChange has already navigated, so a stray Enter
      // keypress should not submit a second time. Without it, this handler
      // never runs and the plain GET below does the work.
      onSubmit={(e) => e.preventDefault()}
    >
      <input type="hidden" name="week" value={weekStart} />
      <select
        name="user"
        defaultValue={selectedId}
        disabled={pending}
        aria-label="Whose timesheet to show"
        onChange={(e) => {
          const user = e.target.value;
          startTransition(() => {
            router.push(
              `/timesheet?week=${weekStart}${user ? `&user=${user}` : ""}`
            );
          });
        }}
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
      >
        <option value="">My timesheet</option>
        {subjects.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <noscript>
        <button
          type="submit"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-100"
        >
          Show
        </button>
      </noscript>
    </form>
  );
}
