/**
 * How a notification reads.
 *
 * No database — these are pure functions, and the thing being defended is
 * editorial rather than technical: every line has to say what to DO, and carry
 * the reason with it. A notification that makes you open the task to find out
 * what is being asked has wasted the interruption it just spent.
 */

import { describe, expect, it } from "vitest";
import { describeNotification, shortAgo } from "@/lib/notifications/describe";
import type { NotificationView } from "@/lib/notifications/service";

function make(
  type: NotificationView["type"],
  payload: Record<string, unknown> = {}
): NotificationView {
  return {
    id: 1n,
    type,
    taskId: 1n,
    payload: payload as NotificationView["payload"],
    readAt: null,
    createdAt: new Date(),
    task: {
      displayKey: "TSK-2026-00001",
      title: "GSTR-3B — July 2026",
      engagement: { name: "GST Compliance", client: { name: "Orchid Textiles" } },
    },
  };
}

describe("every line says what to do", () => {
  it("assignment leads with the deadline", () => {
    // The first thing anyone wants on being handed work.
    const d = describeNotification(
      make("ASSIGNED_TO_ME", { dueDate: "2026-09-30T00:00:00.000Z" })
    );
    expect(d.headline).toBe("Assigned to you");
    // Deterministic regardless of the machine's locale — this box renders
    // "Sept" via toLocaleDateString and an en-US host renders "Sep", which is
    // exactly why the formatting no longer goes through it.
    expect(d.detail).toBe("Due 30 Sep 2026");
  });

  it("assignment prefers an explicit reason over the deadline", () => {
    const d = describeNotification(
      make("ASSIGNED_TO_ME", {
        dueDate: "2026-09-30T00:00:00.000Z",
        reason: "Priya is on leave",
      })
    );
    expect(d.detail).toBe("Priya is on leave");
  });

  it("rejection carries the reason, because that IS the instruction", () => {
    const d = describeNotification(
      make("REVIEW_REJECTED", { reason: "ITC reconciliation is missing" })
    );
    expect(d.headline).toBe("Sent back to you");
    expect(d.detail).toBe("ITC reconciliation is missing");
    // Not neutral. Being sent back is not news, it is work.
    expect(d.tone).toBe("warning");
  });

  it("a moved deadline puts the NEW date in the headline", () => {
    const d = describeNotification(
      make("DUE_DATE_CHANGED", {
        from: "2026-09-30T00:00:00.000Z",
        to: "2026-10-15T00:00:00.000Z",
        reason: "client asked for an extension",
      })
    );
    expect(d.headline).toBe("Deadline moved to 15 Oct 2026");
    expect(d.detail).toMatch(/extension/);
  });

  it("falls back to the old date when no reason was given", () => {
    const d = describeNotification(
      make("DUE_DATE_CHANGED", {
        from: "2026-09-30T00:00:00.000Z",
        to: "2026-10-15T00:00:00.000Z",
      })
    );
    expect(d.detail).toBe("Was 30 Sep 2026");
  });

  it("honours the organisation's date format", () => {
    // The firm decides how a date reads. An organisation that wants
    // "30/09/2026" gets it without anyone editing this file.
    const d = describeNotification(
      make("ASSIGNED_TO_ME", { dueDate: "2026-09-30T00:00:00.000Z" }),
      "dd/MM/yyyy"
    );
    expect(d.detail).toBe("Due 30/09/2026");
  });

  it("falls back rather than crashing on a broken format string", () => {
    const d = describeNotification(
      make("ASSIGNED_TO_ME", { dueDate: "2026-09-30T00:00:00.000Z" }),
      "not-a-real-pattern"
    );
    expect(d.detail).toContain("2026");
  });

  it("a mention shows the excerpt", () => {
    const d = describeNotification(
      make("MENTIONED", { excerpt: "can you check the ITC position?" })
    );
    expect(d.detail).toMatch(/ITC position/);
  });

  it("survives a missing or malformed payload", () => {
    // Payloads are JSON columns written by older code paths. A notification
    // that throws takes the whole page with it.
    for (const type of [
      "ASSIGNED_TO_ME",
      "REVIEW_REQUESTED",
      "REVIEW_REJECTED",
      "DUE_DATE_CHANGED",
      "MENTIONED",
      "ADDED_AS_CONTRIBUTOR",
    ] as const) {
      expect(() => describeNotification(make(type))).not.toThrow();
      expect(describeNotification(make(type)).headline).toBeTruthy();
    }

    expect(() =>
      describeNotification(make("DUE_DATE_CHANGED", { to: "not a date", from: 42 }))
    ).not.toThrow();
  });
});

describe("shortAgo", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const ago = (ms: number) => shortAgo(new Date(now.getTime() - ms), now);

  it("reads the way people say it", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(26 * 3_600_000)).toBe("yesterday");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });

  it("switches to a date once relative time stops helping", () => {
    // "23d ago" makes the reader do arithmetic; a date does not.
    expect(ago(23 * 86_400_000)).toMatch(/Aug/);
  });

  it("never renders a negative age", () => {
    // Clock skew between server and browser is normal; "-2m ago" is not.
    expect(shortAgo(new Date(now.getTime() + 60_000), now)).toBe("just now");
  });
});
