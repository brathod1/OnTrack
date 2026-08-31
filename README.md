# OnTrack

Internal task management for K C Mehta & Co LLP — task-level work tracking and
time recording for a chartered accountancy practice.

**CA-first, configurable architecture.** The firm's vocabulary, roles, timezone,
working week and task-key prefix are *seed data, not code*. There is no
`if (organisation is a CA firm)` anywhere. See "Configurable without code" in
`docs/Stack and Capability.md`.

Scope for the current phase is defined by **`docs/OnTrack — Task Core Build Spec.md`**.
If a feature is not in that document, it is not in this phase.

> Commands below are run from the project root. Substitute your own checkout
> path wherever a shell prompt is shown.

---

## Current status

**Stages 1–15 complete. 393 tests passing · 10 migrations · 21 tables.**

You can sign in as any seeded person, open a task, move it through its
lifecycle, discuss it, run a timer against it, see the week in a timesheet, be
told when something needs you, browse and search everything you can see, read a
manager's view of what is at risk, and export where the hours went as a
spreadsheet.

**`docs/Project Status.md` is the authoritative account of what exists.** This
file tells you how to run and work on it.

What remains: **Stage 16** (security testing, load testing, deployment), and
**email notifications**, which are blocked on a Microsoft Graph approval that was
deliberately deferred. Also unbuilt: admin CRUD screens, configurable statuses
(G4), recurring-task generation, and attachment storage.

### The map of the code

| Path | What it is |
|---|---|
| `prisma/schema.prisma` | The data model. 21 tables. |
| `prisma/migrations/` | Migration history, including hand-written SQL for everything Prisma cannot express |
| `prisma/sql/` | Role setup, grants, and verification scripts — see "Database and migrations" |
| `src/lib/auth/permissions.ts` | **The authorisation kernel.** Every task query composes `visibleTaskFilter` |
| `src/lib/tasks/` | Task service, status machine, My Work, comments, search |
| `src/lib/time/` | Timer, manual entry, timesheet, forgotten-timer watchdog |
| `src/lib/{dashboard,reports,notifications,clients}/` | Team dashboard, time reports and Excel export, in-app notifications, client directory |
| `src/app/(app)/` | The screens. Server components; server actions handle mutations |
| `src/app/api/v1/` | The REST task API — same services, same kernel, no shortcuts |
| `tests/` | 20 files against a real PostgreSQL database, not mocks |

---

## Setup

Requires **Node 20.11+** and **PostgreSQL 15+** (developed against 18.6).

```bash
npm install
npm approve-scripts @prisma/client @prisma/engines esbuild prisma unrs-resolver
npm install                            # re-run so the approved scripts execute
cp .env.example .env                   # then fill in the values
```

> **`.env`, not `.env.local`.** The Prisma CLI reads `.env` only. Next.js reads
> both. Using `.env.local` gives you a working Next.js app and migrations that
> fail with "Environment variable not found: DATABASE_URL".

> **npm 11 blocks install scripts by default.** Without approving the five
> packages above, Prisma's engine binaries are never downloaded and every
> Prisma command fails with a confusing engine error.

Then create the database and roles — see **Setting up a fresh environment**
below, which is the complete and correct sequence.

**Do not run `prisma/sql/01_constraints.sql` by hand.** Its contents are already
inside the initial migration; the file is kept as a readable reference only.
Applying it separately will fail on objects that already exist.

---

## Running it

```bash
npm run dev          # http://localhost:3100
npm test             # 393 tests
npm run typecheck    # tsc --noEmit
npm run db:seed      # rebuild development data (DESTRUCTIVE)
npm run db:test      # bring the test database up to date after a migration
npm run watchdog:dry # report timers past the ceiling, writing nothing
npm run watchdog     # suspend them
```

**Signing in.** In development, the sign-in page lists every seeded user as a
button — click a name. Microsoft Entra is wired but inactive until its three
environment variables exist; adding them switches it on with no code change.
`manager.iyer@demo.invalid` and `exec.gupta@demo.invalid` have the most
interesting data.

To see notifications: sign in as one person, assign work to or mention another,
then sign in as that second person.

**The watchdog needs a scheduler in production** — hourly is ample. Which one
(Task Scheduler, cron, an Azure WebJob) is a Stage 16 decision; it is a process
that exits, so any of them work.

---

## Three things worth knowing before you read the code

**1. Authorisation lives in exactly one place.**
`visibleTaskFilter(user)` returns a Prisma `where` clause; every list query
composes it, and every fetch-by-id calls `assertCanReadTask` after loading.
There is no permission logic in components — UI hiding is cosmetic. A denied
read throws `NotFoundError`, which the API renders as **404, not 403**: a 403
confirms the record exists, which is precisely what someone probing task IDs
wants to learn.

**2. Constraints that matter are in the database, not the service layer.**
The single-running-timer rule is a partial unique index because application
checks race — two clicks 50ms apart both read "no timer" and both insert.
Subtask depth is a trigger because a service-layer check is one forgotten code
path away from an infinite tree. The activity log is append-only because the
app's database role has no `UPDATE` grant, not because we promise not to.

**3. Time data is for planning, never for scoring people.**
`originalEstimateMinutes` freezes at the first time entry so Estimated-vs-Actual
compares like with like. There is no screen that ranks people by estimate
accuracy or hours logged, and none will be added. This is a design constraint,
not an oversight: score estimates and everyone pads them, and within a quarter
the data — and the capacity planning that depends on it — is worthless.

---

## Database and migrations

### The SQL files

| File | When to run | As |
|---|---|---|
| `prisma/sql/00_roles.sql` | Once per environment, **before** the first migration | `postgres` |
| `prisma/sql/01_constraints.sql` | **Never** — a readable reference. The constraints live inside the initial migration | — |
| `prisma/sql/02_grants.sql` | **After** each migration that adds tables | `postgres` |
| `prisma/sql/03_verify.sql` | After any migration, in every environment | `ontrack_owner` |
| `prisma/sql/04_timer_tests.sql` | Any time — runs in a transaction and rolls back | `ontrack_owner` |
| `prisma/sql/05_concurrency_setup.sql` | Before the two-session test. **Commits** | `ontrack_owner` |
| `prisma/sql/06_concurrency_cleanup.sql` | After it. Removes only the `ZZ-` test fixtures | `ontrack_owner` |
| `prisma/sql/examples/` | Two runnable organisation configurations — a CA firm and a software company | `ontrack_owner` |

### Setting up a fresh environment

```powershell
psql -U postgres -h localhost -d postgres -f "prisma\sql\00_roles.sql"
psql -U postgres -h localhost -d postgres -c "CREATE DATABASE ontrack OWNER ontrack_owner ENCODING 'UTF8';"
psql -U postgres -h localhost -d postgres      # then: \password ontrack_owner, \password ontrack_app, \q
# fill in .env
npx prisma migrate deploy
psql -U postgres      -h localhost -d ontrack -f "prisma\sql\02_grants.sql"
psql -U ontrack_owner -h localhost -d ontrack -f "prisma\sql\03_verify.sql"
npm run db:seed
```

The migration carries every constraint with it. There is no separate
constraints step.

### Adding constraints in a later migration

Never edit an applied migration — it is history, and editing it breaks the checksum
for every environment that has already run it.

```powershell
npx prisma migrate dev --name add_x --create-only   # 1. generate, don't apply
#                                                     2. write your SQL into the new file
npx prisma migrate dev                              # 3. apply
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma `
                       --to-schema-datamodel   prisma/schema.prisma --script
#                                                     4. must print "empty migration"
```

**Step 4 is not optional.** Any database object Prisma can't see in `schema.prisma`
is treated as drift, and the next `prisma migrate dev` will offer to DROP it. That
is why `Task.searchVector` is declared as `Unsupported("tsvector")` and why
`TaskKeyCounter` exists as a model — neither is written by Prisma Client; both are
declared purely so migrations leave them alone.

**After any migration, bring the test database up to date too** — `npm run db:test`.
Twice now a migration has been applied to development only, turning ~50 tests red
for a reason that had nothing to do with the code.

---

## Testing

```powershell
npm test              # run once
npm run test:watch    # re-run on change
npm run test:permissions   # the permission kernel only
```

### One-time setup of the test database

```powershell
psql -U postgres -h localhost -d postgres -c "CREATE DATABASE ontrack_test OWNER ontrack_owner ENCODING 'UTF8';"

# Point Prisma at it without typing a password
function Get-EnvValue($name) {
  $line = Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  return ($line -replace "^$name=", '').Trim('"')
}
$env:DATABASE_URL        = (Get-EnvValue 'DATABASE_URL')        -replace '/ontrack\?', '/ontrack_test?'
$env:DIRECT_DATABASE_URL = (Get-EnvValue 'DIRECT_DATABASE_URL') -replace '/ontrack\?', '/ontrack_test?'

npx prisma migrate deploy
psql -U postgres -h localhost -d ontrack_test -f "prisma\sql\02_grants.sql"

Remove-Item Env:DATABASE_URL, Env:DIRECT_DATABASE_URL -ErrorAction SilentlyContinue
npx prisma migrate status     # must report database "ontrack"
```

Thereafter, `npm run db:test` does the same thing in a child process so nothing
leaks into your shell.

### How the harness protects your development data

There is **no `.env.test` file**. `tests/setup.ts` reads the existing `.env` and
substitutes the database name, so passwords live in one place and cannot drift.
Two independent interlocks then apply:

1. **setup.ts** refuses to start if the derived URL doesn't name `ontrack_test`.
2. **helpers/db.ts** re-checks `current_database()` immediately before every
   `TRUNCATE`. A connection string can be right while the connection goes
   somewhere else — a stale env var, a pooler, a host alias.

`fileParallelism` is off: test files share one database and truncate between
cases. In parallel, one file's truncate deletes another's fixtures mid-assertion,
producing failures that move between runs and look like flaky application code.

### What the suites cover

20 files, 393 tests. The ones to read first:

| File | Covers |
|---|---|
| `smoke.test.ts` | The harness itself — right database, right role, schema present, both timer protections installed, no `timestamp without time zone` anywhere |
| `permissions/visibility.test.ts` | Who can see which tasks; cross-team staffing; **404-not-403** on unauthorised lookup; deactivated users |
| `permissions/write-access.test.ts` | Protected fields, estimate freezing, who may log time, status transitions |
| `permissions/cross-department.test.ts` | Assigning work across teams, and that it does **not** hand over the whole engagement |
| `grants.test.ts` | The **database** grants, via a second client on the restricted `ontrack_app` connection |
| `timer/race.test.ts` | 12 simultaneous timer starts → exactly one wins; suspended and soft-deleted timers; overlapping sessions |
| `tasks/`, `time/`, `dashboard/`, `reports/`, `clients/`, `notifications/`, `api/` | The services behind each screen |

Tests connect as `ontrack_owner` because fixtures need teardown and the app role
deliberately has no DELETE. `grants.test.ts` is the exception, and exists so the
two layers — application kernel and database privileges — stay independently
verifiable. A failure in one is then unambiguous.

---

## Outstanding verification

- ~~Timer concurrency under true parallelism~~ — **closed in Stage 3.**
  `tests/timer/race.test.ts` fires 12 simultaneous starts through the connection
  pool and asserts exactly one succeeds, with the losers rejected specifically by
  `uniq_running_timer_per_user` rather than by a pool timeout or deadlock. The
  earlier manual two-psql-window attempt was abandoned: coordinating a held-open
  transaction across two windows proved unreliable, and both attempts silently
  re-tested the sequential case.

---

## Known technical debt

- **`npm run db:test` cannot run unattended.** It shells out to
  `psql -U postgres`, which prompts for a password. Fine interactively; it will
  not work in CI or a script until the grants step takes a connection string.

- **Test fixtures are slow.** `tests/tasks/service.test.ts` rebuilds the fixture
  firm in `beforeEach` (necessary — those tests mutate), costing ~900ms per test.
  `buildFirm` is ~25 sequential awaits; batching the independent inserts into
  `createMany` calls should cut it by most of that. The full suite now runs in
  about three minutes.

- **`package.json#prisma` is deprecated.** Prisma 6.19 warns that the `prisma.seed`
  key moves to a `prisma.config.ts` file and is removed in Prisma 7. It works on
  6.x. Deliberately not migrated yet — the config file also changes how the
  schema and `.env` are located, and that risk isn't worth taking to silence a
  warning. **Must be resolved before upgrading to Prisma 7.**

- **7 npm audit findings** (3 moderate, 4 high) at time of install, all in
  transitive dependencies. To be reviewed properly at Stage 16 hardening.
  `npm audit fix --force` is not the answer — it performs major-version upgrades.

- **Four unused dependencies.** `lucide-react`, `clsx`, `class-variance-authority`
  and `tailwind-merge` appear nowhere in `src/`. Should be removed before
  deployment. `pg-boss` and `@azure/storage-blob` are also unused but are held
  for named future stages (email queue, attachments).

- **Historical team reports follow the current reporting line**, not the line as
  at the time. Accepted for this phase.

---

## Conventions

- **Durations are integers in minutes.** Never floats, never seconds.
- **A calendar day is `@db.Date`.** `TimeEntry.workDate` is a date, not a timestamp, so Friday's work logged on Monday stays dated Friday and no report shifts on a UTC boundary.
- **Nothing is hard-deleted** except join rows. Everything else soft-deletes with a reason.
- **`task.actualMinutes` is a cache** of `SUM(time_entries.duration_minutes)`, written in the same transaction. A nightly job reports drift rather than silently correcting it — silent correction hides the bug that caused it.
- **BigInt ids** don't survive `JSON.stringify`. Use `serialise()` at the API boundary.
- **Never compare a role name.** Ask whether the user holds a capability. Roles are rows an administrator can rename; capabilities are constants the code checks.
