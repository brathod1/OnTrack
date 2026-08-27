"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The filter bar on the browse screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FILTERS LIVE IN THE URL, not in component state. Three things follow, and
 * all three matter more than the implementation cost:
 *
 *   A filtered view can be BOOKMARKED and SENT. "Everything overdue on
 *   Orchid" becomes a link a partner pastes into an email.
 *   The BACK BUTTON works, because each change is a navigation.
 *   The server renders the results, so there is no client-side copy of the
 *   task list to go stale.
 *
 * THE SEARCH BOX IS DEBOUNCED; EVERYTHING ELSE APPLIES IMMEDIATELY. Typing
 * produces a keystroke's worth of intent at a time and a query per character
 * is waste. Choosing from a dropdown is a finished thought.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface TaskFiltersProps {
  clients: FilterOption[];
  people: FilterOption[];
  statuses: FilterOption[];
  priorities: FilterOption[];
  /** How the organisation says "client". */
  clientLabel: string;
}

const SEARCH_DEBOUNCE_MS = 300;

export function TaskFilters({
  clients,
  people,
  statuses,
  priorities,
  clientLabel,
}: TaskFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [search, setSearch] = useState(params.get("q") ?? "");

  /** Replace one parameter and navigate. Absent values are removed, not blanked. */
  function apply(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }

    // Any filter change invalidates the page cursor — page 3 of the old
    // result set is meaningless in the new one.
    next.delete("cursor");

    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
    });
  }

  // Debounce the search box only.
  useEffect(() => {
    const current = params.get("q") ?? "";
    if (search === current) return;

    const id = setTimeout(() => {
      // The schema requires two characters. Rather than let the server reject
      // it, treat one character as "not searching yet" — the user is still
      // typing and an error message would be noise.
      apply({ q: search.trim().length >= 2 ? search.trim() : null });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const active = countActive(params);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles and descriptions…"
          aria-label="Search"
          className="min-w-[16rem] flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />

        <Select
          label={clientLabel}
          name="client"
          options={clients}
          value={params.get("client")}
          onChange={(v) => apply({ client: v })}
        />
        <Select
          label="Assignee"
          name="assignee"
          options={people}
          value={params.get("assignee")}
          onChange={(v) => apply({ assignee: v })}
        />
        <Select
          label="Status"
          name="status"
          options={statuses}
          value={params.get("status")}
          onChange={(v) => apply({ status: v })}
        />
        <Select
          label="Priority"
          name="priority"
          options={priorities}
          value={params.get("priority")}
          onChange={(v) => apply({ priority: v })}
        />

        <Toggle
          label="Overdue"
          on={params.get("overdue") === "1"}
          onClick={() => apply({ overdue: params.get("overdue") === "1" ? null : "1" })}
        />
        <Toggle
          label="Blocked"
          on={params.get("blocked") === "1"}
          onClick={() => apply({ blocked: params.get("blocked") === "1" ? null : "1" })}
        />

        {active > 0 && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              startTransition(() => router.push(pathname));
            }}
            className="text-sm text-slate-600 underline hover:text-slate-900"
          >
            Clear
          </button>
        )}
      </div>

      {search.trim().length === 1 && (
        <p className="text-xs text-slate-400">Keep typing — search needs two characters.</p>
      )}
    </div>
  );
}

function countActive(params: URLSearchParams): number {
  let n = 0;
  for (const key of ["q", "client", "assignee", "status", "priority", "overdue", "blocked"]) {
    if (params.get(key)) n += 1;
  }
  return n;
}

function Select({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: FilterOption[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      name={name}
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={`rounded-md border px-2 py-1.5 text-sm ${
        value
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 bg-white text-slate-700"
      }`}
    >
      {/* The label doubles as the empty option, so an unset filter still says
          what it filters. A bare "All" tells you nothing about which column. */}
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-white text-slate-900">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-md border px-3 py-1.5 text-sm ${
        on
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
      }`}
    >
      {label}
    </button>
  );
}
