"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getNotificationsAction,
  markAllReadAction,
  markReadAction,
} from "@/lib/notifications/actions";
import type { NotificationRow } from "@/lib/notifications/types";

/**
 * The bell, and the panel it opens.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A PANEL, NOT A PAGE. This reverses an earlier decision, and the earlier one
 * was wrong: a full page is cheaper to build, but a notification you must
 * leave your work to read is one you check less often. The entire value is
 * being glanceable, and a page is not a glance.
 *
 * LOADED ON OPEN, NOT ON EVERY PAGE. The header needs one number. Fetching a
 * list into every server render — for a panel most people open a few times a
 * day — is work repeated on every navigation for nothing.
 *
 * THE COUNT IS CAPPED AT 9+. A bell reading "47" tells you nothing you can act
 * on and teaches you to stop looking. If it is routinely high, the answer is
 * fewer notifications, not a wider badge.
 * ─────────────────────────────────────────────────────────────────────────
 */

const TONE_DOT: Record<NotificationRow["tone"], string> = {
  neutral: "bg-slate-300",
  attention: "bg-blue-500",
  warning: "bg-amber-500",
};

export function NotificationPanel({ unread }: { unread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();
  const [locallyRead, setLocallyRead] = useState<Set<string>>(new Set());

  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await getNotificationsAction(8));
    } finally {
      setLoading(false);
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Re-fetched on every open rather than cached: something may have arrived
    // since, and a panel showing yesterday's list is worse than a short wait.
    if (next) void load();
  }

  // Close on an outside click or Escape. Both, because people reach for
  // whichever is nearer and a panel that traps you is worse than no panel.
  useEffect(() => {
    if (!open) return;

    function onPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isRead = (r: NotificationRow) => r.read || locallyRead.has(r.id);
  const visibleUnread = Math.max(
    0,
    unread - [...locallyRead].length
  );

  function openRow(row: NotificationRow) {
    if (!isRead(row)) {
      // Dims immediately; the server is still the authority.
      setLocallyRead((prev) => new Set(prev).add(row.id));
      startTransition(() => void markReadAction([row.id]));
    }
    setOpen(false);
    if (row.taskKey) router.push(`/tasks/${row.taskKey}`);
  }

  const label =
    visibleUnread === 0 ? "Notifications" : `Notifications, ${visibleUnread} unread`;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-md p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        {/* Inline rather than an icon package: one glyph, and it never changes. */}
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {visibleUnread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white"
            aria-hidden
          >
            {visibleUnread > 9 ? "9+" : visibleUnread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-medium text-slate-900">Notifications</span>
            {visibleUnread > 0 && (
              <button
                type="button"
                onClick={() => {
                  setLocallyRead(
                    new Set((rows ?? []).map((r) => r.id))
                  );
                  startTransition(async () => {
                    await markAllReadAction();
                    router.refresh();
                  });
                }}
                className="text-xs text-slate-500 underline hover:text-slate-800"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
            {loading && rows === null ? (
              <p className="px-3 py-6 text-center text-sm text-slate-400">Loading…</p>
            ) : !rows || rows.length === 0 ? (
              <p className="px-3 py-6 text-sm text-slate-500">
                Nothing here. You are told when work is assigned to you, when it
                is sent back, when someone mentions you, and when one of your
                deadlines moves.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const read = isRead(row);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => openRow(row)}
                        className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-slate-50 ${
                          read ? "opacity-60" : ""
                        }`}
                      >
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            read ? "bg-transparent" : TONE_DOT[row.tone]
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            <span className={read ? "text-slate-700" : "font-medium text-slate-900"}>
                              {row.headline}
                            </span>
                            {row.taskTitle && (
                              <span className="text-slate-600"> {row.taskTitle}</span>
                            )}
                          </span>
                          {row.detail && (
                            <span className="mt-0.5 block truncate text-xs italic text-slate-500">
                              {row.detail}
                            </span>
                          )}
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            {[row.clientName, row.taskKey, row.ago]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-slate-100 px-3 py-2">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-600 underline hover:text-slate-900"
            >
              See all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
