/**
 * Parsing and formatting durations the way people actually write them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Time entry is the most repeated interaction in the whole product. Someone
 * fills in five or six of these every evening, for years. Every extra
 * keystroke and every rejected input is paid hundreds of times a month, so
 * this is worth more care than its size suggests.
 *
 * Two separate number boxes for hours and minutes would need no parser at
 * all, but costs a tab keypress on every single entry and reads badly on a
 * phone. One field that accepts what people naturally type is better, PROVIDED
 * it never guesses wrong.
 *
 * THE ONE AMBIGUITY, AND HOW IT IS SETTLED: a bare "2" could mean 2 hours or 2
 * minutes. This reads it as HOURS, because that is how the work is discussed
 * ("that took about two") and because nobody records a two-minute task. Bare
 * decimals follow the same rule, so "1.5" is ninety minutes.
 *
 * The failure mode is someone meaning "45 minutes" who types "45". Large
 * mistakes are caught here — 45 becomes 45 hours, past the day ceiling, and is
 * refused. But a bare "5" becomes five hours and is entirely plausible, so no
 * validation will ever catch it.
 *
 * THE ACTUAL MITIGATION IS THE UI, NOT THIS FUNCTION: the field echoes its
 * interpretation back as you type ("5" → "5h 0m"), so the misreading is
 * visible at the moment it happens rather than at month-end. A parser that
 * accepts natural input has to be paired with that echo; without it, prefer
 * two separate boxes.
 * ─────────────────────────────────────────────────────────────────────────
 */

export class DurationParseError extends Error {}

/** Nothing legitimate is longer than this, and the day cap is stricter still. */
const MAX_MINUTES = 24 * 60;

/**
 * Accepts, case-insensitively and with any spacing:
 *
 *   90m   90 min   90 mins   90 minutes      →  90
 *   2h    2 hr     2 hours                   → 120
 *   1.5h  1.5      1,5                       →  90
 *   1h30  1h 30m   1 hour 30 minutes         →  90
 *   1:30  0:45                               →  90, 45
 *
 * Returns whole minutes, rounded. Throws DurationParseError on anything else —
 * deliberately, rather than returning 0, because a silent zero is a lost
 * afternoon that nobody notices until the month-end report.
 */
export function parseDuration(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/,/g, ".");
  if (!text) throw new DurationParseError("Enter how long you spent.");

  const minutes = attemptParse(text);

  if (minutes === null) {
    throw new DurationParseError(
      `"${raw.trim()}" is not a length of time. Try 1h 30m, 1:30, 90m or 1.5.`
    );
  }
  if (minutes <= 0) {
    throw new DurationParseError("Enter how long you spent.");
  }
  if (minutes > MAX_MINUTES) {
    throw new DurationParseError("That is longer than a day.");
  }

  return Math.round(minutes);
}

function attemptParse(text: string): number | null {
  // 1:30 — clock notation. Minutes are capped at 59; "1:75" is a typo, not
  // an hour and a quarter, and guessing which would be presumptuous.
  const clock = /^(\d+):([0-5]\d)$/.exec(text);
  if (clock) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }

  // 1h30, 1h 30m, 1 hour 30 minutes, 2h, 45m — units, either or both.
  const units = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?)?$/.exec(
    text
  );
  if (units && (units[1] !== undefined || units[2] !== undefined)) {
    const hasHourUnit = units[1] !== undefined;

    // A trailing bare number AFTER an hour unit is minutes ("1h30"), but a
    // bare number on its own is hours ("1.5"). The presence of the hour unit
    // is what disambiguates, so this never has to guess.
    const hours = hasHourUnit ? Number(units[1]) : 0;
    const mins = units[2] !== undefined ? Number(units[2]) : 0;

    if (!hasHourUnit && units[2] !== undefined) {
      // Bare number, or a number with an explicit minute unit.
      const bareNumber = /^\d+(?:\.\d+)?$/.test(text);
      return bareNumber ? Number(text) * 60 : mins;
    }

    return hours * 60 + mins;
  }

  return null;
}

/**
 * "7h 30m", "45m", "8h".
 *
 * Never "7.5h": a decimal invites the reader to do arithmetic to find out
 * what half an hour is, and 7.25 vs 7:25 is a genuine misreading.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";

  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);

  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** For the timer's live readout, where seconds are the point. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
