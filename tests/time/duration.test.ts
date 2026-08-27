/**
 * The duration parser.
 *
 * No database, so these run in milliseconds — which matters, because this is
 * the one piece of the system where the correct behaviour is a long list of
 * specific cases rather than a rule. The list is the specification.
 */

import { describe, expect, it } from "vitest";
import { DurationParseError, formatDuration, formatElapsed, parseDuration } from "@/lib/time/duration";

describe("parsing what people type", () => {
  it("reads explicit units", () => {
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("90 min")).toBe(90);
    expect(parseDuration("90 mins")).toBe(90);
    expect(parseDuration("90 minutes")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("2 hr")).toBe(120);
    expect(parseDuration("2 hours")).toBe(120);
  });

  it("reads hours and minutes together", () => {
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("1 hour 30 minutes")).toBe(90);
    expect(parseDuration("7h 45m")).toBe(465);
  });

  it("reads clock notation", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("0:45")).toBe(45);
    expect(parseDuration("10:05")).toBe(605);
  });

  it("reads a bare number as HOURS", () => {
    // The deliberate choice. "1.5" is how people say ninety minutes.
    expect(parseDuration("1.5")).toBe(90);
    expect(parseDuration("2")).toBe(120);
    expect(parseDuration("0.25")).toBe(15);
  });

  it("accepts a comma as a decimal separator", () => {
    // Common on non-UK keyboards and in European locales; no reason to refuse.
    expect(parseDuration("1,5")).toBe(90);
  });

  it("ignores case and spacing", () => {
    expect(parseDuration("  2H 15M  ")).toBe(135);
    expect(parseDuration("2H15")).toBe(135);
  });

  it("rounds to whole minutes", () => {
    // 0.33 hours is 19.8 minutes. The ledger stores integers.
    expect(parseDuration("0.33")).toBe(20);
  });
});

describe("refusing what it cannot read", () => {
  const bad = ["", "   ", "soon", "1h2h", "abc30", "-2", "1:75", "3:4", "1..5", "h30"];

  it.each(bad)("refuses %o", (input) => {
    expect(() => parseDuration(input)).toThrow(DurationParseError);
  });

  it("refuses more than a day", () => {
    // Also what catches the "45 meaning 45 minutes" slip: 45 hours.
    expect(() => parseDuration("45")).toThrow(/longer than a day/i);
    expect(() => parseDuration("25h")).toThrow(/longer than a day/i);
  });

  it("refuses zero", () => {
    // Never returns 0 silently. A silent zero is a lost afternoon that nobody
    // notices until month-end.
    expect(() => parseDuration("0")).toThrow(DurationParseError);
    expect(() => parseDuration("0m")).toThrow(DurationParseError);
  });

  it("says what it would have accepted", () => {
    // An error that only says "invalid" makes the user guess the format.
    expect(() => parseDuration("ages")).toThrow(/1h 30m/);
  });
});

describe("round trips", () => {
  it("parses back what it formats", () => {
    for (const minutes of [1, 15, 45, 60, 90, 135, 465, 480, 1439]) {
      expect(parseDuration(formatDuration(minutes))).toBe(minutes);
    }
  });
});

describe("formatting", () => {
  it("writes hours and minutes, never decimals", () => {
    // "7.5h" makes the reader do arithmetic, and 7.25 vs 7:25 is a real
    // misreading.
    expect(formatDuration(450)).toBe("7h 30m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(480)).toBe("8h");
  });

  it("handles nothing gracefully", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
  });

  it("shows a running timer with seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});
