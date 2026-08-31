# OnTrack — Project Status

**As at:** 31 August 2026 · **Commit:** `a472a6d` · **Branch:** `main`
**34 commits · 393 tests passing · 10 migrations · 21 tables**

---

## 1. What exists and works today

You can run `npm run dev`, sign in as any of nine seeded people, open a task, move it through its lifecycle, discuss it, run a timer against it, see the week in a timesheet, be told when something needs you, browse and search everything you can see, read a manager's view of what is at risk, and export where the hours went as a spreadsheet.

**The product is feature-complete for its scope.** What remains is Stage 16 — security testing, load testing and deployment — plus email notifications, which are blocked on a Microsoft Graph approval you deliberately deferred.

### Database

| | |
|---|---|
| PostgreSQL 18 | `ontrack` (development) and `ontrack_test` (isolated test database) |
| 21 tables | Organisation, roles, users, teams, clients, engagements, tasks, time entries, comments, attachments, activity log, notifications, recurrence, saved views |
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

**Seven real defects have been caught by these constraints during construction**, including two in the Microsoft Entra sign-in path — code that cannot run today and would have failed on the first real sign-in after the app registration is approved. The seventh was caught while writing the timesheet tests: fixture rows that went around the service to insert nine-hour entries with no note were refused by the database anyway. Going around the service does not mean going around the invariants, which is the entire argument for putting them here.

### Permissions

Capability + relationship, in every decision:

> **Capability** grants the ability. **Relationship** grants the scope.

"May reassign tasks" is a capability; "…but only on engagements she manages, or for her reports" is a relationship. Both are always checked.

Visibility is a **union of relationships** — assignee, contributor, reviewer, creator, engagement member, line manager, engagement partner — not an org-chart walk. This is what makes cross-team staffing work: a Direct Tax senior can be staffed onto an audit engagement without breaking either the org chart or the permission model.

**Engagement membership grants engagement-wide read — except for observers.** Being assigned a task on an engagement you do not already belong to attaches you to it as an `OBSERVER`, and an observer membership opens nothing on its own: you reach your own task through the assignee relationship and see none of the engagement's other work. Anything else — Member, In-charge, Manager, Partner — is a working membership and does see the whole engagement. See §4.

Unauthorised reads return **404, never 403**. A 403 would confirm the record exists, which is what someone probing task IDs is trying to learn.

### Application

- **Authentication** — Auth.js, session carries only a user id; role and scope re-read from the database on every request, so deactivating someone takes effect immediately
- **Task API** — create, update, assign, transition, block, contributors, list. Optimistic locking on every write; the activity log written inside the same transaction as the change it records
- **My Work** — one prioritised list (overdue → sent back → due today → awaiting review → blocked → this week → later), not four widgets. Below it, separated, **"Waiting on someone else"** — open work you asked a colleague for, which is otherwise on no screen you own. Excluded from every workload figure, because it is not your work
- **Cross-department requesting** — any employee may create a task on an engagement they belong to and assign it to anyone active in the firm, whatever team they are in. Departments have never been a permission boundary here. The requester gains no authority over the work: they cannot reassign it, move its deadline, change its priority, cancel it, or log time against it
- **Quick create** — four visible fields, `N` to open, Ctrl+Enter to save, stays open for creating in runs. The assignee picker shows each person's current load, so overload is visible *at the moment of delegation*
- **Task detail** — description, people, dates, estimate vs actual, subtasks, full history in plain sentences
- **Status workflow** — only the transitions the kernel permits are rendered; reasons are dialogs, not skippable fields; conflicts offer reload, never silent retry
- **Comments** — 15-minute author edit window, then fixed. Nobody may edit another person's words, manager included. Removal leaves a tombstone, and the original text goes to the activity log
- **Time tracking** — server-owned timer surviving reloads and devices, manual entry as a first-class path, a duration field that echoes what it understood, and a weekly grid whose empty days are the point
- **Forgotten-timer watchdog** — `npm run watchdog` (and `--dry-run`). Suspends rather than guessing; a suspended entry counts toward nothing until its owner says what they worked
- **Notifications** — a panel in the header. You are told when work is assigned to you, when it is sent back, when someone mentions you, when a deadline of yours moves, and when you are added as a contributor. Nothing else
- **Team dashboard** — what's at risk, where the load is, what each client is absorbing. No completion rates, no estimate accuracy, no ranking of people
- **Browse** — every task you can see, with full-text search and filters that live in the URL, so a filtered view can be bookmarked and pasted into an email. Search is scoped before it is capped, so your own matching work cannot be pushed off the end by the rest of the firm's
- **"Asked by" on Team and Browse** — a row names who *requested* the work as well as who is doing it, but only when that is news: nothing is shown when the assignee created their own task, or when you did. Discloses nothing new — the name was already on the task page — and is what makes a cross-department request visible at a glance instead of one click at a time
- **Clients** — the map: which clients, which engagements, what's open and late, hours to date. Every row leads into Browse
- **Reports** — where the hours went, by client, engagement and person over any date range, downloadable as a two-sheet spreadsheet

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
| **12** | **Email notifications** — the in-app half is built; email is not. See below |
| **16** | Security testing, load testing, deployment |

Stages 8 to 15 are complete, bar email.

**Weekly timesheet approval is OUT OF SCOPE**, decided 31 August 2026. It was
previously listed here as designed-but-unbuilt, which read as an outstanding
debt. It is not: it will not be built in this release, and no approval tables,
states, screens or API exist. The consequence to state plainly is that hours are
recorded and never formally confirmed by anyone — accepted deliberately, not
overlooked. The reasoning behind the original design is kept in §4 and in the
Product Specification, because the decision may be revisited later.

**On email:** it is not merely unbuilt, it is *blocked by a decision you made deliberately*. Microsoft Graph was excluded from the Entra app registration IT is approving, so sending mail needs a second approval round. The engine is channel-agnostic and `notifications.email_sent_at` is the seam — adding email later means a sender and a job, not a redesign. Until then, people are told only while they are in the app, which is the honest limitation to state to whoever approves this.

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
| **Assignment attaches you to the engagement as an OBSERVER** | Revised 31 Aug 2026. Putting work on someone's plate *is* attaching them, and the record has to stay accurate because `ensureEngagementMembership` is the only writer of membership in the application. But it is not *staffing* them: assignment used to write MEMBER, which granted read access to every task on the engagement — so borrowing a specialist for one job handed them the whole client file. Nobody decided that; it fell out of two reasonable rules meeting. An existing membership is never downgraded |
| **Weekly timesheet approval is out of scope** | Decided 31 Aug 2026. The reasoning below is kept because the decision may be revisited |
| **Estimate accuracy never enters an appraisal** | Score it and everyone pads; within a quarter the data — and the capacity planning built on it — is worthless |
| **Weekly timesheet approval, not per-entry** | Per-entry review is rigorous on paper and rubber-stamped in practice |
| **Workload counts leaf tasks only** | Counting a parent and its subtasks double-counts the same work |
| **Forgotten timers are suspended, not auto-logged** | Writing 14 silent hours poisons the data and destroys trust in every number |
| **The server owns the timer clock** | A browser four minutes fast would show a timer four minutes ahead of what gets recorded, and people believe the display over the ledger |
| **The watchdog is a plain script, not a queued job** | It is idempotent and its ceiling is ten hours, so a missed run costs nothing. pg-boss earns its place at Stage 12, where notifications genuinely need a queue |
| **Confirming a suspended timer is not an "edit"** | "Edited a time entry from 0m to 2h 30m" invites exactly the suspicion an append-only log exists to remove |
| **A timer stopped inside a minute is discarded** | Recording 0m is honest and useless; rounding up invents time |
| **Reading someone's timesheet needs the same standing as correcting it** | Otherwise the two drift into "can fix what they cannot see" |
| **Notifications are written in the causing transaction, not queued** | A crash between committing an assignment and enqueuing its notification leaves work on a plate with nobody told. Email is the opposite case and is where a queue will earn its place |
| **Told on standing, not visibility** | Plenty of people can see a task; almost none need telling when it changes. Notifying everyone who can see it is how a bell becomes wallpaper |
| **Nobody is notified of their own action** | Enforced centrally, not at each call site — six places to forget is six places it will be forgotten |
| **Reports read the ledger, never the cached total** | `task.actualMinutes` is a lifetime figure. A report bounded by dates that read it would sum correctly and silently ignore its own date range |
| **The spreadsheet is built from the same object the page renders** | One that disagrees with the screen it came from is worse than none: one is wrong, nobody can tell which, and both stop being trusted |
| **Minutes are authoritative; hours are a convenience** | 20 minutes is 0.33 hours. Rounded and summed a thousand times, that drifts |
| **The download endpoint re-checks everything** | The URL is guessable. An endpoint that trusts the page which linked to it has no authorisation at all |

---

## 5. Known risks

| Risk | Standing |
|---|---|
| **Adoption** — if logging time takes more than ~20 seconds a day, the system is abandoned | The largest risk, and not a technical one. Quick-create and the weekly grid are the mitigations |
| **Punitive use of the data** | If estimates or hours feed appraisals, data quality collapses within a quarter. The product deliberately builds no screen that ranks people |
| **Missing estimates** | A workload figure that silently omits unestimated work is how managers stop trusting the screen. Every figure shows what it could not count |
| **Duplicate time entry** | **Answered: OnTrack is the sole system of record for time.** Nothing to integrate with, and no second place to log |
| **A bare number in the time field means hours** | So "45" meaning 45 minutes becomes 45 hours. Large slips are refused past the day ceiling, but a bare "5" becomes five hours and is entirely plausible — no validation can catch it. Mitigated by the field echoing its interpretation as you type. Watch whether real users still get caught |

---

## 6. Technical debt

- `package.json#prisma` is deprecated; must move to `prisma.config.ts` before Prisma 7
- Test fixtures rebuild per test; batching the inserts would cut most of that. The full suite runs in about three minutes
- `npm run db:test` shells out to `psql -U postgres` and prompts for a password, so it cannot run unattended or in CI
- 7 npm audit findings in transitive dependencies, for Stage 16
- Four unused dependencies (`lucide-react`, `clsx`, `class-variance-authority`, `tailwind-merge`) to remove before deployment
- Historical team reports follow the *current* reporting line, not the line as at the time
- **A manager sees work their staff requested only where they already have a relationship to it.** There is no "created by someone who reports to me" visibility rule. Raised and deliberately not acted on — it would widen the permission model
- **A Staff member assigning work to a Senior attaches that Senior to the engagement**, and `canManageTask` still reads all memberships regardless of capacity — so that Senior can then direct every task on it. Pre-existing, unchanged by the observer work, and the one place the old over-grant survives. Open decision

---

## 7. How to run it

```powershell
# from the project root
npm run dev          # http://localhost:3100
npm test             # 393 tests
npm run db:seed      # rebuild development data (destructive)
npm run db:test      # bring the test database up to date after a migration
npm run watchdog:dry # report timers past the ceiling, writing nothing
npm run watchdog     # suspend them
```

To see notifications: sign in as one person, assign them work or mention them from another, then sign back in as the first.

The watchdog needs a scheduler in production — hourly is ample. Which one (Task Scheduler, cron, an Azure WebJob) is a Stage 16 decision; it is a process that exits, so any of them work.

Sign in as any seeded user — `manager.iyer@demo.invalid` and `exec.gupta@demo.invalid` have the most interesting data.
