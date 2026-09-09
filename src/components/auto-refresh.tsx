"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the current page current, without anyone pressing F5.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM: nothing in this product pushes. Pages are `force-dynamic`, so
 * the data is never stale — but the PAGE is, because nothing asks for it
 * again. A manager assigned work and the person it landed on saw nothing,
 * indefinitely, until they happened to reload. With email notifications still
 * unbuilt, that left no path at all by which somebody learned work had
 * arrived.
 *
 * `router.refresh()` re-fetches the server components for the current route
 * and reconciles them into the existing tree. Two consequences make it the
 * right tool rather than a reload:
 *
 *   - client state survives — a half-typed comment or an open dialog is not
 *     thrown away, which a `location.reload()` would do
 *   - the LAYOUT is re-rendered too, so the unread count on the bell comes
 *     along for free. One mechanism, both problems
 *
 * ── Only while the tab is visible ────────────────────────────────────────
 * A forgotten tab left open overnight should cost nothing. The interval is
 * torn down when the page is hidden and started again when it returns, and a
 * refresh fires immediately on return so somebody coming back from Outlook
 * sees the current picture rather than waiting up to another interval for it.
 *
 * ── Not a live feed, and not pretending to be ────────────────────────────
 * This is polling. Genuine push (SSE or a socket) was cut from scope
 * deliberately, and this is not a quiet attempt to build it: at THIRTY
 * SECONDS the screen catches up on its own, which is what "did my colleague
 * get it?" actually needs. Shortening this materially would be a different
 * decision with a different cost — see the note below.
 *
 * ── The cost, measured rather than assumed ───────────────────────────────
 * My Work renders in about 4ms; `getCreateOptions`, which runs alongside it,
 * measured 10ms at fifty people and 36ms at two hundred and fifty. At fifty
 * people polling twice a minute that is roughly a second of database time per
 * minute — negligible. It does mean the standing decision NOT to optimise
 * `getCreateOptions` is now load-bearing on this interval: shorten it, or grow
 * a lot, and that query is the first thing to revisit.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Long enough to be cheap, short enough that nobody thinks it is broken. */
const REFRESH_MS = 30_000;

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };

    const start = () => {
      stop(); // never leave two intervals running after a visibility flip
      timer = setInterval(() => {
        // Re-checked here as well as on the event: a tab can be hidden by the
        // OS without always firing visibilitychange first.
        if (document.visibilityState === "visible") router.refresh();
      }, REFRESH_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        router.refresh(); // catch up now, not in up to thirty seconds
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
