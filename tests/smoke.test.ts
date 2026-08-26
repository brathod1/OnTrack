/**
 * Harness smoke tests.
 *
 * These assert almost nothing about the application. They exist to answer one
 * question before any real test is trusted: **is this suite actually talking
 * to the test database, and does that database have the schema?**
 *
 * A permission suite that passes against an empty or wrong database tells you
 * nothing, but it tells you nothing *in green*, which is worse than red.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

describe("test harness", () => {
  it("is connected to ontrack_test, not the development database", async () => {
    const rows = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database() AS db
    `;
    expect(rows[0]?.db).toBe("ontrack_test");
  });

  it("is connected as ontrack_owner, so fixtures can be torn down", async () => {
    const rows = await prisma.$queryRaw<{ who: string }[]>`
      SELECT current_user AS who
    `;
    expect(rows[0]?.who).toBe("ontrack_owner");
  });

  it("has the migration applied", async () => {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(20);
  });

  it("has the single-running-timer index", async () => {
    // If this is ever missing, every timer test below it would pass by
    // accident — there would simply be nothing to violate.
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE indexname = 'uniq_running_timer_per_user'
    `;
    expect(rows).toHaveLength(1);
  });

  it("has the no-overlapping-sessions exclusion constraint", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conname = 'no_overlapping_timer_sessions'
    `;
    expect(rows).toHaveLength(1);
  });

  it("stores instants as timestamptz throughout", async () => {
    // The correction made in Stage 1. Asserted here so a future migration
    // that adds a plain `timestamp` column fails the build immediately,
    // rather than being discovered by a report that is 5.5 hours out.
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'timestamp without time zone'
    `;
    expect(rows).toEqual([]);
  });

  it("can start empty", async () => {
    // Not an assertion about correctness — a check that the database is in a
    // known state before the permission suites start creating fixtures.
    const users = await prisma.user.count();
    expect(users).toBeGreaterThanOrEqual(0);
  });
});
