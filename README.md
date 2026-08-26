# OnTrack

Internal task management for K C Mehta & Co LLP.

Scope is defined by **`docs/OnTrack — Task Core Build Spec.md`**. If a feature is not in that document, it is not in this phase.

**Project root:** `D:\Data Backup\OnTrack` — every command below is run from there.

---

## Stage 1 status — foundation

| File | What it is |
|---|---|
| `prisma/schema.prisma` | 18 tables. The complete Phase-1 data model. |
| `prisma/sql/01_constraints.sql` | The rules Prisma can't express: single running timer, no overlapping sessions, subtask depth cap, task invariants, task keys, full-text search. |
| `prisma/sql/02_grants.sql` | Database roles. Makes the activity log append-only by withholding UPDATE/DELETE from the app's role. |
| `src/lib/auth/permissions.ts` | The authorisation kernel. Every task query composes `visibleTaskFilter`. |
| `src/lib/tasks/transitions.ts` | The status machine. Nothing writes `task.status` directly. |
| `src/lib/db.ts` | Prisma client + BigInt serialisation. |

**Still to come in Stage 1:** Entra auth wiring, seed data, permission contract tests, admin CRUD.

---

## Setup

Requires Node 20+ and PostgreSQL 15+.

```powershell
cd "D:\Data Backup\OnTrack"
npm install
npm approve-scripts @prisma/client @prisma/engines esbuild prisma unrs-resolver
npm install                            # re-run so the approved scripts execute
Copy-Item .env.example .env            # then fill in the values
```

> **`.env`, not `.env.local`.** The Prisma CLI reads `.env` only. Next.js reads
> both. Using `.env.local` gives you a working Next.js app and migrations that
> fail with "Environment variable not found: DATABASE_URL".

> **npm 11 blocks install scripts by default.** Without approving the five
> packages above, Prisma's engine binaries are never downloaded and every
> Prisma command fails with a confusing engine error.

Create the database and roles:

```bash
createdb ontrack
psql ontrack -f prisma/sql/02_grants.sql    # as the DB owner, once
```

Run the migration, then apply the raw constraints:

```bash
npx prisma migrate dev --name init
psql ontrack -f prisma/sql/01_constraints.sql
```

> **Important:** paste `01_constraints.sql` into the generated migration file under
> `prisma/migrations/…/migration.sql` so it becomes part of migration history.
> Left as a manual step, it will be forgotten on the next environment — and the
> single-running-timer index is not optional.

```bash
npm run db:seed
npm run dev
```

---

## Three things worth knowing before you read the code

**1. Authorisation lives in exactly one place.**
`visibleTaskFilter(user)` returns a Prisma `where` clause; every list query composes it, and every fetch-by-id calls `assertCanReadTask` after loading. There is no permission logic in components — UI hiding is cosmetic. A denied read throws `NotFoundError`, which the API renders as **404, not 403**: a 403 confirms the record exists, which is precisely what someone probing task IDs wants to learn.

**2. Constraints that matter are in the database, not the service layer.**
The single-running-timer rule is a partial unique index because application checks race — two clicks 50ms apart both read "no timer" and both insert. Subtask depth is a trigger because a service-layer check is one forgotten code path away from an infinite tree. The activity log is append-only because the app's database role has no `UPDATE` grant, not because we promise not to.

**3. Time data is for planning, never for scoring people.**
`originalEstimateMinutes` freezes at the first time entry so Estimated-vs-Actual compares like with like. There is no screen that ranks people by estimate accuracy or hours logged, and none will be added. This is a design constraint, not an oversight: score estimates and everyone pads them, and within a quarter the data — and the capacity planning that depends on it — is worthless.

---

## Database and migrations

### The SQL files

| File | When to run | As |
|---|---|---|
| `prisma/sql/00_roles.sql` | Once per environment, **before** the first migration | `postgres` |
| `prisma/sql/01_constraints.sql` | **Never** — a pointer. The constraints live inside the initial migration | — |
| `prisma/sql/02_grants.sql` | **After** each migration that adds tables | `postgres` |
| `prisma/sql/03_verify.sql` | After any migration, in every environment | `ontrack_owner` |
| `prisma/sql/04_timer_tests.sql` | Any time — runs in a transaction and rolls back | `ontrack_owner` |
| `prisma/sql/05_concurrency_setup.sql` | Before the two-session test. **Commits** | `ontrack_owner` |
| `prisma/sql/06_concurrency_cleanup.sql` | After it. Removes only the `ZZ-` test fixtures | `ontrack_owner` |

### Setting up a fresh environment

```powershell
psql -U postgres -h localhost -d postgres -f "prisma\sql\00_roles.sql"
psql -U postgres -h localhost -d postgres -c "CREATE DATABASE ontrack OWNER ontrack_owner ENCODING 'UTF8';"
psql -U postgres -h localhost -d postgres      # then: \password ontrack_owner, \password ontrack_app, \q
# fill in .env
npx prisma migrate deploy
psql -U postgres      -h localhost -d ontrack -f "prisma\sql\02_grants.sql"
psql -U ontrack_owner -h localhost -d ontrack -f "prisma\sql\03_verify.sql"
```

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

---

## Outstanding verification

- **Timer concurrency under true parallelism.** `04_timer_tests.sql` proves the
  constraint rejects a second running timer, and manual two-session testing
  confirmed the rejection — but not the *blocking* behaviour while two
  transactions are in flight, because coordinating two psql windows mid-
  transaction proved unreliable. **To be covered by an automated two-connection
  race test in Stage 3.** The guarantee itself rests on the partial unique index,
  which is verified present with the correct predicate by `03_verify.sql` §3.

---

## Known technical debt

- **`package.json#prisma` is deprecated.** Prisma 6.19 warns that the `prisma.seed`
  key moves to a `prisma.config.ts` file and is removed in Prisma 7. It works on
  6.x. Deliberately not migrated yet — the config file also changes how the
  schema and `.env` are located, and that risk isn't worth taking to silence a
  warning. **Must be resolved before upgrading to Prisma 7.**
- **7 npm audit findings** (3 moderate, 4 high) at time of install, all in
  transitive dependencies. To be reviewed properly at Stage 16 hardening.
  `npm audit fix --force` is not the answer — it performs major-version upgrades.

---

## Conventions

- **Durations are integers in minutes.** Never floats, never seconds.
- **A calendar day is `@db.Date`.** `TimeEntry.workDate` is a date, not a timestamp, so Friday's work logged on Monday stays dated Friday and no report shifts on a UTC boundary.
- **Nothing is hard-deleted** except join rows. Everything else soft-deletes with a reason.
- **`task.actualMinutes` is a cache** of `SUM(time_entries.duration_minutes)`, written in the same transaction. A nightly job reports drift rather than silently correcting it — silent correction hides the bug that caused it.
- **BigInt ids** don't survive `JSON.stringify`. Use `serialise()` at the API boundary.
