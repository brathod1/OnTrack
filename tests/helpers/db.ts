import { prisma } from "@/lib/db";

/**
 * Wipe every table between tests.
 *
 * TRUNCATE rather than deleting row by row: it ignores foreign-key ordering
 * when given every table at once, and RESTART IDENTITY resets the sequences so
 * ids are stable across runs. A test that passes only because it happened to
 * get id 7 is a test that will fail next week.
 */

/** Every table, in no particular order — CASCADE handles the dependencies. */
const TABLES = [
  // Listed first for readability only — CASCADE handles the dependency order,
  // and organizations is now the root every person, team and client hangs off.
  "organizations",
  "activity_log",
  "notifications",
  "time_entries",
  "task_contributors",
  "task_tags",
  "comments",
  "attachments",
  "tasks",
  "recurrence_instances",
  "recurrence_rules",
  "engagement_members",
  "engagements",
  "clients",
  "saved_views",
  "tags",
  "users",
  "teams",
  "settings",
  "task_key_counters",
] as const;

let guardChecked = false;

/**
 * Second interlock, independent of tests/setup.ts.
 *
 * setup.ts checks the connection *string*; this checks what the database
 * actually reports once connected. A string can be right while the connection
 * goes somewhere else — a stale environment variable, a pooler, a typo in a
 * host alias. Since the next statement is TRUNCATE, being paranoid here is
 * proportionate: the cost of the check is one query, the cost of being wrong
 * is someone's data.
 */
async function assertTestDatabase(): Promise<void> {
  if (guardChecked) return;

  const rows = await prisma.$queryRaw<{ db: string }[]>`
    SELECT current_database() AS db
  `;
  const db = rows[0]?.db;

  if (db !== "ontrack_test") {
    throw new Error(
      `REFUSING TO TRUNCATE. Connected to "${db}", expected "ontrack_test".`
    );
  }
  guardChecked = true;
}

export async function resetDatabase(): Promise<void> {
  await assertTestDatabase();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
}
