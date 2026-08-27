"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { markAllReadAction, markReadAction } from "@/lib/notifications/actions";
import type { NotificationRow } from "@/lib/notifications/types";

/**
 * The notifications list.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ AND UNREAD LIVE IN ONE LIST, not two tabs. The question people arrive
 * with is "what have I missed", and the answer is usually a mix — something
 * unread, and the thing above it they read but did not act on. Splitting them
 * hides the second.
 *
 * CLICKING A NOTIFICATION MARKS IT READ AND OPENS THE TASK. Anything else asks
 * people to do bookkeeping on their own inbox, which they will not do, and the
 * count drifts until it means nothing.
 * ─────────────────────────────────────────────────────────────────────────
 */

const TONE_DOT: Record<NotificationRow["tone"], string> = {
  neutral: "bg-slate-300",
  attention: "bg-blue-500",
  warning: "bg-amber-500",
};

export function NotificationList({ rows }: { rows: NotificationRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Optimistic: the row should dim the instant it is clicked, not after a
  // round trip. The server is still the authority — this only hides latency.
  const [locallyRead, setLocallyRead] = useState<Set<string>>(new Set());

  const isRead = (r: NotificationRow) => r.read || locallyRead.has(r.id);
  const unreadCount = rows.filter((r) => !isRead(r)).length;

  function open(row: NotificationRow) {
    if (!isRead(row)) {
      setLocallyRead((prev) => new Set(prev).add(row.id));
      startTransition(() => void markReadAction([row.id]));
    }
    if (row.taskKey) router.push(`/tasks/${row.taskKey}`);
  }

  if (rows.length === 0) {
    return (
      <p className="mt-8 text-sm text-slate-500">
        Nothing here. You are told when work is assigned to you, when it is sent
        back, when someone mentions you, and when one of your deadlines moves.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {unreadCount === 0 ? "All caught up" : `${unreadCount} unread`}
        </p>

        {unreadCount > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const ids = rows.filter((r) => !isRead(r)).map((r) => r.id);
              setLocallyRead((prev) => new Set([...prev, ...ids]));
              startTransition(async () => {
                await markAllReadAction();
                router.refresh();
              });
            }}
            className="text-sm text-slate-600 underline hover:text-slate-900 disabled:opacity-50"
          >
            Mark all read
          </button>
        )}
      </div>

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {rows.map((row) => {
          const read = isRead(row);
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => open(row)}
                className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 ${
                  read ? "opacity-60" : ""
                }`}
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    read ? "bg-transparent" : TONE_DOT[row.tone]
                  }`}
                  aria-hidden
                />

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={`text-sm ${read ? "text-slate-700" : "font-medium text-slate-900"}`}
                    >
                      {row.headline}
                    </span>
                    {row.taskTitle && (
                      <span className="truncate text-sm text-slate-600">
                        {row.taskTitle}
                      </span>
                    )}
                  </span>

                  {row.detail && (
                    <span className="mt-0.5 block truncate text-sm italic text-slate-500">
                      {row.detail}
                    </span>
                  )}

                  <span className="mt-0.5 block text-xs text-slate-400">
                    {[row.clientName, row.taskKey].filter(Boolean).join(" · ")}
                  </span>
                </span>

                <span className="shrink-0 text-xs text-slate-400">{row.ago}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-slate-400">
        You are told about work addressed to you — not about everything you can
        see. <Link href="/tasks" className="underline">My work</Link> is the
        full picture.
      </p>
    </div>
  );
}
