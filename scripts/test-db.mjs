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
run("psql", ["-U", "postgres", "-h", "localhost", "-d", TEST_DB, "-f", "prisma/sql/02_grants.sql"]);

console.log(`\n✔ ${TEST_DB} is up to date. Your shell still points at ${DEV_DB}.`);
