# OnTrack — Project Status

**As at:** 26 August 2026 · **Commit:** `eb570a8` · **Branch:** `main`
**13 commits · 156 tests passing · 6 migrations · 22 tables**

---

## 1. What exists and works today

You can run `npm run dev`, sign in as any of nine seeded people, and see a task list that differs correctly for each of them. That is the honest summary. Below it is a great deal of foundation.

### Database

| | |
|---|---|
| PostgreSQL 18 | `ontrack` (development) and `ontrack_test` (isolated test database) |
| 22 tables | Organisation, roles, users, teams, clients, engagements, tasks, time entries, comments, attachments, activity log, notifications, recurrence, saved views |
| Two database roles | `ontrack_owner` owns the schema; `ontrack_app` runs the application with deliberately restricted grants |

**Invariants enforced by PostgreSQL rather than by convention:**

- One running timer per user — a partial unique index, because application checks race
- No overlapping timer sessions — a GiST exclusion constraint
- Subtasks capped at one level — a trigger
- Nobody reviews their own work
- Blocked needs a reason; cancelling needs a reason
- Due date can never pass its external deadline
- **Activity log is append-only** — the application's database role has no `UPDATE` or `DELETE` on it
- Tasks, time entries, comments and users cannot be hard-deleted by the application

**Six real defects have been caught by these constraints during construction**, including two in the Microsoft Entra sign-in path — code that cannot run today and would have failed on the first real sign-in after the app registration is approved.

### Permissions

Capability + relationship, in every decision:

> **Capability** grants the ability. **Relationship** grants the scope.

"May reassign tasks" is a capability; "…but only on engagements she manages, or for her reports" is a relationship. Both are always checked.

Visibility is a **union of relationships** — assignee, contributor, reviewer, creator, engagement member, line manager, engagement partner — not an org-chart walk. This is what makes cross-team staffing work: a Direct Tax senior can be staffed onto an audit engagement without breaking either the org chart or the permission model.

Unauthorised reads return **404, never 403**. A 403 would confirm the record exists, which is what someone probing task IDs is trying to learn.

### Application

- **Authentication** — Auth.js, session carries only a user id; role and scope re-read from the database on every request, so deactivating someone takes effect immediately
- **Task API** — create, update, assign, transition, block, contributors, list. Optimistic locking on every write; the activity log written inside the same transaction as the change it records
- **My Work** — one prioritised list (overdue → sent back → due today → awaiting review → blocked → this week → later), not four widgets
- **Quick create** — four visible fields, `N` to open, Ctrl+Enter to save, stays open for creating in runs. The assignee picker shows each person's current load, so overload is visible *at the moment of delegation*

### Configuration

The CA firm is **seed data, not code**. There is no `if (organisation is a CA firm)` anywhere.

| Configurable now | Set where |
|---|---|
| Organisation name, logo, timezone, date format, working week | `organizations` row |
| Task key prefix, search language | same |
| Roles, and the capabilities each holds | `roles` rows |
| Vocabulary — Client/Customer, Engagement/Project, Statutory/SLA | `organizations.terminology` |

Demonstrated, not asserted: `prisma/sql/examples/` contains two runnable configurations. Applying the software-company one turns "Clients" into "Customers" and "STAT" into "SLA" with no code change.

---

## 2. What is NOT built

Being explicit, because the foundation makes the product look further along than it is.

| Stage | What's missing |
|---|---|
| **8** | **Task detail page** — you cannot open a task |
| **9** | Status workflow UI — no start / submit / approve buttons |
| **10** | Comments and contributors UI |
| **11** | Time tracking UI — the timer exists in the database, not on screen |
| **12** | Notifications |
| **13** | Dashboards — employee and senior |
| **14** | Filtering and search UI |
| **15** | Reports and export |
| **16** | Security testing, load testing, deployment |

Also outstanding:

- **G4 — configurable statuses.** Design settled: organisation-chosen label plus engine-owned category (`NOT_STARTED` / `ACTIVE` / `PENDING_REVIEW` / `DONE` / `CANCELLED`), so "overdue" and "completion rate" keep their meaning whatever a status is called. Deferred because the migration stays mechanical while all status logic funnels through `transitions.ts`.
- **Recurring tasks** — the schema and rules engine exist; the generation job does not.
- **Attachments** — schema exists; Azure Blob wiring does not.

---

## 3. Blocked

**Microsoft Entra app registration** — awaiting approval.

Not blocking development. Auth.js is configured with the Entra provider *present but inactive* until three environment variables exist; a development sign-in provider (hard-disabled outside development, three separate guards) covers local work. When approval lands, adding those three values switches Entra on with no code change.

What IT needs to create: a single-tenant app registration, redirect URI `/api/auth/callback/microsoft-entra-id`, and delegated scopes `openid profile email`. **No Microsoft Graph access at all** in this phase.

---

## 4. Decisions worth remembering

| Decision | Why |
|---|---|
| **Client → Engagement → Task** | A "project" that doesn't roll up to a client can't answer "how many hours on ABC Ltd's audit" |
| **One accountable assignee, plus contributors** | Multiple assignees destroy accountability and make workload arithmetic impossible |
| **Blocked is a flag, not a status** | A status loses where the work actually was |
| **Assignment adds you to the engagement** | Putting work on someone's plate *is* staffing them |
| **Estimate accuracy never enters an appraisal** | Score it and everyone pads; within a quarter the data — and the capacity planning built on it — is worthless |
| **Weekly timesheet approval, not per-entry** | Per-entry review is rigorous on paper and rubber-stamped in practice |
| **Workload counts leaf tasks only** | Counting a parent and its subtasks double-counts the same work |
| **Forgotten timers are suspended, not auto-logged** | Writing 14 silent hours poisons the data and destroys trust in every number |

---

## 5. Known risks

| Risk | Standing |
|---|---|
| **Adoption** — if logging time takes more than ~20 seconds a day, the system is abandoned | The largest risk, and not a technical one. Quick-create and the weekly grid are the mitigations |
| **Punitive use of the data** | If estimates or hours feed appraisals, data quality collapses within a quarter. The product deliberately builds no screen that ranks people |
| **Missing estimates** | A workload figure that silently omits unestimated work is how managers stop trusting the screen. Every figure shows what it could not count |
| **Duplicate time entry** | If your practice-management software already records time, integrate rather than duplicate — two places to log time means neither gets used. **Still unanswered** |

---

## 6. Technical debt

- `package.json#prisma` is deprecated; must move to `prisma.config.ts` before Prisma 7
- Test fixtures rebuild per test (~32s for the service suite); batching the inserts would cut most of that
- 7 npm audit findings in transitive dependencies, for Stage 16
- Historical team reports follow the *current* reporting line, not the line as at the time

---

## 7. How to run it

```powershell
cd "D:\Data Backup\OnTrack"
npm run dev          # http://localhost:3100
npm test             # 156 tests
npm run db:seed      # rebuild development data (destructive)
npm run db:test      # bring the test database up to date after a migration
```

Sign in as any seeded user — `manager.iyer@demo.invalid` and `exec.gupta@demo.invalid` have the most interesting data.
