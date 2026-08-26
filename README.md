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
Copy-Item .env.example .env.local     # then fill in the values
```

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

## Conventions

- **Durations are integers in minutes.** Never floats, never seconds.
- **A calendar day is `@db.Date`.** `TimeEntry.workDate` is a date, not a timestamp, so Friday's work logged on Monday stays dated Friday and no report shifts on a UTC boundary.
- **Nothing is hard-deleted** except join rows. Everything else soft-deletes with a reason.
- **`task.actualMinutes` is a cache** of `SUM(time_entries.duration_minutes)`, written in the same transaction. A nightly job reports drift rather than silently correcting it — silent correction hides the bug that caused it.
- **BigInt ids** don't survive `JSON.stringify`. Use `serialise()` at the API boundary.
