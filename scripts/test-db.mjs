#!/usr/bin/env node
/**
 * Bring the TEST database up to date.
 *
 *   npm run db:test
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: `ontrack_test` is a separate database and does not get
 * migrations for free. Twice now a migration has been applied to development,
 * the suite has gone red across ~50 tests, and the cause has been a missing
 * migration on the test database rather than anything wrong with the code.
 *
 * That is a process failure, not a knowledge failure — the sequence is six
 * commands including an environment-variable swap that must be undone
 * afterwards, and forgetting one of them is the default outcome.
 *
 * The env swap is done in a CHILD process, so nothing leaks into the parent
 * shell. Previously this was done by exporting variables and remembering to
 * remove them; forgetting meant every subsequent command in that terminal
 * silently targeted the test database.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEV_DB = "ontrack";
const TEST_DB = "ontrack_test";

const root = process.cwd();
const envPath = path.join(root, ".env");

let raw;
try {
  raw = readFileSync(envPath, "utf8");
} catch {
  console.error(`Cannot read ${envPath}. Copy .env.example to .env first.`);
  process.exit(1);
}

function readVar(name) {
  const line = raw.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${name}=`));
  if (!line) {
    console.error(`${name} is missing from .env`);
    process.exit(1);
  }
  return line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
}

const toTest = (url) => url.replace(`/${DEV_DB}?`, `/${TEST_DB}?`);
const mask = (url) => url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:********@");

const appUrl = toTest(readVar("DATABASE_URL"));
const ownerUrl = toTest(readVar("DIRECT_DATABASE_URL"));

// The same interlock the test harness uses. If the substitution failed, this
// would otherwise migrate the DEVELOPMENT database — silently and destructively.
for (const [label, url] of [["DATABASE_URL", appUrl], ["DIRECT_DATABASE_URL", ownerUrl]]) {
  if (!new RegExp(`/${TEST_DB}(\\?|$)`).test(url)) {
    console.error(
      `REFUSING TO RUN.\n${label} does not point at "${TEST_DB}".\nResolved to: ${mask(url)}`
    );
    process.exit(1);
  }
}

console.log(`Target: ${mask(ownerUrl)}\n`);

const childEnv = { ...process.env, DATABASE_URL: appUrl, DIRECT_DATABASE_URL: ownerUrl };

/**
 * Connection details for psql, taken from the URL Prisma already uses.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The grants step used to run as the `postgres` SUPERUSER, whose password is
 * nowhere in this project — `.env` carries `ontrack_app` and `ontrack_owner`
 * and nothing else. So psql fell back to asking a human, which is fine at a
 * terminal and a hang anywhere else: CI, a scheduled run, or any script.
 *
 * A superuser was never needed here. `00_roles.sql` creates roles and does
 * need one; `02_grants.sql` creates nothing. It grants and revokes on objects
 * that already exist, and in PostgreSQL you may grant on what you own —
 * `ontrack_owner` owns the database, the `public` schema (via
 * `pg_database_owner`) and every table in it.
 *
 * The password is passed through PGPASSWORD in the CHILD ENVIRONMENT rather
 * than in the connection string, so it never reaches the command line and
 * cannot be read out of the process list.
 * ─────────────────────────────────────────────────────────────────────────
 */
const owner = new URL(ownerUrl);
const psqlEnv = {
  ...childEnv,
  // Percent-decoded: a password containing @ or / must be encoded in the URL
  // and would otherwise be sent to the server in its encoded form.
  PGPASSWORD: decodeURIComponent(owner.password),
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`\n"${command} ${args.join(" ")}" failed.`);
    process.exit(result.status ?? 1);
  }
}

console.log("── Applying migrations ──────────────────────────────────────");
run("npx", ["prisma", "migrate", "deploy"], { env: childEnv });

console.log("\n── Re-applying grants ───────────────────────────────────────");
// Needed after any migration that adds a table: a new table arrives with no
// privileges for ontrack_app. The file uses current_database(), so the same
// script is correct against any database.
//
// ON_ERROR_STOP=1 is not optional. Without it psql skips past a failing
// statement, carries on, and EXITS 0 — so a grants run that half-worked was
// reported here as "✔ up to date" while ontrack_app quietly lacked
// privileges. Measured, not assumed: the same file with one bad statement
// exits 0 without this flag and 3 with it.
run(
  "psql",
  [
    "-v", "ON_ERROR_STOP=1",
    "-U", decodeURIComponent(owner.username),
    "-h", owner.hostname,
    "-p", owner.port || "5432",
    "-d", TEST_DB,
    "-f", "prisma/sql/02_grants.sql",
  ],
  { env: psqlEnv }
);

console.log(`\n✔ ${TEST_DB} is up to date. Your shell still points at ${DEV_DB}.`);
