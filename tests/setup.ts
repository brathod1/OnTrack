/**
 * Vitest global setup.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE POINT OF THIS FILE: make it impossible for the test suite to run
 * against the development database.
 *
 * A test suite that silently connects to the wrong database is worse than no
 * test suite at all — it reports green while proving nothing, and its
 * truncation destroys real data. So this file derives the test URL, then
 * refuses to start if the result doesn't name `ontrack_test`.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * There is deliberately no `.env.test` file. Duplicating the database
 * passwords into a second file doubles the chance of one leaking and doubles
 * the work when a password changes. Instead we read the existing `.env` and
 * substitute the database name, which cannot drift out of step.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";

const TEST_DB_NAME = "ontrack_test";
const DEV_DB_NAME = "ontrack";

// ── Read .env without a dotenv dependency ───────────────────────────────────

const envPath = path.resolve(process.cwd(), ".env");

let rawEnv: string;
try {
  rawEnv = readFileSync(envPath, "utf8");
} catch {
  throw new Error(
    `Cannot read ${envPath}. Copy .env.example to .env and fill in the database passwords.`
  );
}

function readEnvVar(name: string): string {
  const line = rawEnv
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${name}=`));

  if (!line) throw new Error(`${name} is missing from .env`);

  return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
}

/** Swap the database name, leaving credentials, host, port and params intact. */
function pointAtTestDatabase(url: string): string {
  return url.replace(`/${DEV_DB_NAME}?`, `/${TEST_DB_NAME}?`);
}

/** Never print a connection string with its password intact. */
function mask(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:********@");
}

// ── The interlock ───────────────────────────────────────────────────────────

const ownerUrl = pointAtTestDatabase(readEnvVar("DIRECT_DATABASE_URL"));
const appUrl = pointAtTestDatabase(readEnvVar("DATABASE_URL"));

for (const [label, url] of [
  ["DIRECT_DATABASE_URL", ownerUrl],
  ["DATABASE_URL", appUrl],
] as const) {
  if (!new RegExp(`/${TEST_DB_NAME}(\\?|$)`).test(url)) {
    throw new Error(
      `REFUSING TO RUN TESTS.\n` +
        `${label} does not point at "${TEST_DB_NAME}".\n` +
        `Resolved to: ${mask(url)}\n` +
        `Tests truncate tables. Running them against the development database ` +
        `would destroy data.`
    );
  }
}

/**
 * Tests connect as ontrack_owner, not ontrack_app.
 *
 * Fixtures have to be created and torn down, and the application role
 * deliberately has no DELETE or TRUNCATE on tasks, users, comments or time
 * entries. That restriction is correct for the application and wrong for a
 * test harness.
 *
 * The two protections are independent layers and are verified separately:
 *   - the DATABASE grants   → tests/grants.test.ts, using an app-role client
 *   - the APPLICATION kernel → tests/permissions/*.test.ts, which is what
 *                              actually decides who sees what
 *
 * Testing the kernel through a connection that also blocks writes would
 * conflate the two and make failures ambiguous.
 */
process.env.DATABASE_URL = ownerUrl;
process.env.DIRECT_DATABASE_URL = ownerUrl;

/** Kept for the grants test, which needs a genuinely restricted connection. */
process.env.TEST_APP_DATABASE_URL = appUrl;

// ── Teardown ────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Imported lazily: importing it at the top would construct a PrismaClient
  // before the environment variables above are set.
  const { prisma } = await import("@/lib/db");
  await prisma.$disconnect();
});
