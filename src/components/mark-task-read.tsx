"use client";

import { useEffect, useRef } from "react";
import { markTaskReadAction } from "@/lib/notifications/actions";

/**
 * Marks this task's notifications read once it is genuinely on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A CLIENT EFFECT RATHER THAN A LINE IN THE PAGE COMPONENT:
 *
 * Next.js prefetches links on hover. Calling markTaskRead() during server
 * render would fire for every task a person's mouse passed over in a list —
 * their unread count would drop for work they never opened. An effect runs
 * only when the page has actually been rendered in a browser by someone
 * looking at it.
 *
 * WHY MARK ON OPEN AT ALL: someone who has just read the task does not then
 * need a bell about it. Leaving it unread teaches people the count is
 * unreliable, and an unreliable count is ignored — which costs more than the
 * occasional line marked read a moment early.
 *
 * Renders nothing.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function MarkTaskRead({ taskId }: { taskId: string }) {
  // React runs effects twice in development Strict Mode. The action is
  // idempotent — the second call updates zero rows — but the ref avoids a
  // pointless round trip and the confusing duplicate in the network log.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void markTaskReadAction(taskId);
  }, [taskId]);

  return null;
}
