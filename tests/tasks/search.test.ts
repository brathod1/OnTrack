/**
 * Search and the overdue filter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Both of these were already wrong in shipped code, and both were wrong in the
 * same quiet way: they returned a plausible answer instead of failing.
 *
 *   `search` was declared in the schema and never read by the service. Asking
 *   for "GSTR" returned EVERYTHING, and the caller had no way to tell.
 *
 *   `overdue` used the server's UTC day rather than the organisation's, so for
 *   five and a half hours every evening it silently omitted a day of genuinely
 *   late work.
 *
 * A filter that quietly does nothing is worse than one that throws.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { listTasks } from "@/lib/tasks/service";
import { listTasksSchema } from "@/lib/tasks/schemas";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** Parse through the real schema so defaults (limit) are applied as in production. */
function filters(input: Record<string, unknown>) {
  return listTasksSchema.parse(input);
}

const keys = (result: { tasks: { displayKey: string }[] }) =>
  result.tasks.map((t) => t.displayKey);

describe("free-text search", () => {
  it("finds a task by a word in its title", async () => {
    const found = await listTasks(actor.admin!, filters({ search: "advance" }));
    expect(keys(found)).toContain("TSK-TEST-0001"); // "Prepare advance tax computation"
  });

  it("NARROWS the list — the bug was that it did not", async () => {
    const all = await listTasks(actor.admin!, filters({}));
    const searched = await listTasks(actor.admin!, filters({ search: "advance" }));

    expect(all.tasks.length).toBeGreaterThan(searched.tasks.length);
    expect(keys(searched)).not.toContain("TSK-TEST-0003"); // "Vouching of purchases"
  });

  it("returns NOTHING when nothing matches", async () => {
    // The critical case. If no matches quietly meant "no filter", the original
    // bug would still be here wearing a different hat.
    const found = await listTasks(
      actor.admin!,
      filters({ search: "xylophone quarterly" })
    );
    expect(found.tasks).toHaveLength(0);
  });

  it("stems, so a search finds a different form of the word", async () => {
    // "filing" should find "File GSTR-3B". This is what the configured
    // search language buys, and why it is configuration rather than a literal.
    const found = await listTasks(actor.admin!, filters({ search: "filing" }));
    expect(keys(found)).toContain("TSK-TEST-0004");
  });

  it("searches the description as well as the title", async () => {
    await prisma.task.update({
      where: { id: firm.tasks.t6 },
      data: { description: "Reconcile the amalgamation reserve before signing." },
    });

    const found = await listTasks(actor.admin!, filters({ search: "amalgamation" }));
    expect(keys(found)).toContain("TSK-TEST-0006");
  });

  it("survives punctuation without throwing", async () => {
    // websearch_to_tsquery tolerates what people actually type. plainto_
    // tsquery throws on some of it, which would turn a stray quote into a 500.
    for (const q of ['"GSTR', "tax -audit", "a & b |", "???", "''"]) {
      await expect(
        listTasks(actor.admin!, filters({ search: q }))
      ).resolves.toBeDefined();
    }
  });

  it("refuses a one-character search before it reaches the database", async () => {
    // Not a limitation — a deliberate floor. One character matches most of the
    // corpus, so it is a slow way to ask for everything, and the schema stops
    // it at the boundary rather than the query planner discovering it later.
    expect(() => filters({ search: "a" })).toThrow();
  });

  it("respects visibility — search is not a way around the scope", async () => {
    // The obvious hole in any search feature. Chandra is active and related to
    // nothing; a query matching every task in the firm must still find her
    // none of them.
    const found = await listTasks(actor.chandra!, filters({ search: "tax" }));
    expect(found.tasks).toHaveLength(0);
  });

  it("combines with other filters rather than replacing them", async () => {
    const found = await listTasks(
      actor.admin!,
      filters({ search: "tax", assigneeId: firm.users.eshan.toString() })
    );

    for (const t of found.tasks) {
      expect(t.assigneeId).toBe(firm.users.eshan);
    }
  });
});

describe("the overdue filter", () => {
  it("uses the organisation's day, not the server's", async () => {
    // A task due YESTERDAY in the organisation's timezone is overdue, whatever
    // hour it happens to be in UTC when the query runs.
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { dueDate: yesterday, status: TaskStatus.IN_PROGRESS },
    });

    const found = await listTasks(actor.admin!, filters({ overdue: true }));
    expect(keys(found)).toContain("TSK-TEST-0001");
  });

  it("does not call today's work overdue", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { dueDate: today },
    });

    const found = await listTasks(actor.admin!, filters({ overdue: true }));
    expect(keys(found)).not.toContain("TSK-TEST-0001");
  });

  it("excludes work that is finished, however late it was", async () => {
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    await prisma.task.update({
      where: { id: firm.tasks.t1 },
      data: { dueDate: yesterday, status: TaskStatus.COMPLETED },
    });

    const found = await listTasks(actor.admin!, filters({ overdue: true }));
    expect(keys(found)).not.toContain("TSK-TEST-0001");
  });
});
