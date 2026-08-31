# OnTrack — Stack and Capability

**As at:** 31 August 2026 · **393 tests passing · 10 migrations · 21 tables**

Two questions answered here: *what does this software depend on*, and *what can it actually do today*.

---

# Part 1 — What we depend on

## Runtime and language

| | Version | Why |
|---|---|---|
| **Node.js** | 24.19 (dev) / ≥20.11 required | Whatever Azure App Service offers on the LTS line |
| **TypeScript** | 5.7 | Strict mode. The permission kernel and the time ledger are both places where a wrong type is a wrong number |
| **PostgreSQL** | 18.6 | Chosen for what it can *enforce*, not for speed — see the invariants section |

## Framework

| | Version | What it does here |
|---|---|---|
| **Next.js** | 15.5 (App Router) | Server components render every page; server actions handle every mutation. There is no separate API server to keep in step |
| **React** | 19 | `useActionState` for forms, `useTransition` for optimistic updates |
| **Tailwind CSS** | 3.4 | Utility classes only. No design system, no component library |

**One consequence worth stating plainly:** because pages are server components, almost all the code runs on the server. The browser receives HTML and a small amount of JavaScript for the timer, the notification panel and a few forms. There is no client-side data store to go stale.

## Data

| | Version | What it does here |
|---|---|---|
| **Prisma** | 6.19.3 | Schema, migrations, and a typed client. Not used as an abstraction over SQL — several constraints are hand-written and Prisma is told to leave them alone |
| **@prisma/client** | 6.19.3 | The generated client |

**Two database roles**, deliberately:

- `ontrack_owner` owns the schema and runs migrations
- `ontrack_app` runs the application, with `DELETE` withheld on tasks, time entries, comments and users, and both `UPDATE` and `DELETE` withheld on the activity log

The application *cannot* hard-delete a task or rewrite history, even if the code tried.

## Authentication

| | Version | Status |
|---|---|---|
| **Auth.js (NextAuth)** | 5.0 beta | Configured with the Microsoft Entra ID provider **present but inactive** until three environment variables exist |

A development-only credentials provider covers local work, hard-disabled outside development by three independent guards. The session carries a user id and nothing else — role, capabilities and engagement scope are re-read from the database on every request, so deactivating someone takes effect immediately rather than when their session expires.

## Validation

| | Version | Where |
|---|---|---|
| **Zod** | 3.24 | Every mutation boundary. Validation runs *before* authorisation, so a malformed request never reaches a permission check that might load rows on its behalf |

## Utilities

| | Version | Where |
|---|---|---|
| **date-fns** | 4.1 | Notification dates, formatted from the organisation's configured pattern rather than the server's locale |

## Testing

| | Version | |
|---|---|---|
| **Vitest** | 3.2.7 | 393 tests across 20 files against a real PostgreSQL database (`ontrack_test`), not mocks |
| **tsx** | 4.19 | Runs the seed and the watchdog job |

Test files run **sequentially, not in parallel** — they share one physical database and truncate between cases. Parallel runs produced failures that moved around between runs and looked like flaky code rather than a broken harness.

---

## Declared but not yet used

Two dependencies are in `package.json` and appear **nowhere in `src/`**. Each is supply-chain surface and something somebody has to keep patched, so they are listed rather than left to be discovered. (`exceljs` was on this list until Stage 15 and has been struck through below.)

| Package | Intended for | Status |
|---|---|---|
| `pg-boss` | Job queue | Stage 12 decided in-app notifications need no queue — they are written in the same transaction as the change that causes them. It will earn its place when **email** is built, which needs retries against an external service |
| ~~`exceljs`~~ | Spreadsheet export | **Now in use** — the time report's two-sheet workbook |
| `@azure/storage-blob` | Attachments | Schema exists; the Azure wiring does not |

**Removed 31 August 2026:** `lucide-react`, `clsx`, `class-variance-authority`
and `tailwind-merge` — four packages carried for a component library that was
never built. The product's two icons are hand-written inline SVG and its class
names are plain template literals, so nothing referenced any of them; the
production build and all 403 tests passed unchanged after removal. Note that
`clsx` was also a dependency *of* `class-variance-authority`, so removing it
alone would have left it installed.

`pg-boss` and `@azure/storage-blob` are kept, both scheduled for named stages.

## What we deliberately did NOT use

Named because the absence is a decision, not an oversight — and because these are the things a reviewer will ask about:

| Not used | Why |
|---|---|
| **Redis** | Nothing here needs a cache. `getCurrentOrganization()` is one indexed row on a one-row table, served from PostgreSQL's own buffers. A cache would buy microseconds and cost a class of stale-configuration bug that is genuinely hard to diagnose |
| **Elasticsearch** | PostgreSQL full-text search (a `tsvector` column with GIN indexes) covers a firm's task corpus comfortably. A second datastore to keep in sync is a permanent cost |
| **Microservices** | One deployable. A firm of sixty people does not have a scaling problem, and distributed transactions would make the activity-log-in-the-same-transaction guarantee impossible |
| **A component library** (MUI, shadcn, Chakra) | The product has perhaps fifteen distinct UI elements. A library is a large dependency and a styling argument in exchange for saving a few hundred lines |
| **A client state manager** (Redux, Zustand, React Query) | Server components mean there is no client-side copy of the data to manage |
| **An ORM abstraction over Prisma** | Prisma is already the abstraction. A second layer would hide the constraints doing the real work |
| **AI features** | Explicitly out of scope |

---

# Part 2 — What it can actually do

## The database enforces the rules, not just the code

**Seven real defects have been caught by these constraints during construction** — including two in the Microsoft Entra sign-in path, code which cannot run today and would have failed on the first real sign-in after approval.

| Invariant | Mechanism |
|---|---|
| One running timer per person | Partial unique index — application checks race, indexes do not |
| No overlapping timer sessions | GiST exclusion constraint over a `tstzrange` |
| Subtasks capped at one level | Trigger |
| Nobody reviews their own work | CHECK constraint |
| Blocked needs a reason; cancelling needs a reason | CHECK constraints |
| Time entries over 8 hours need a note | CHECK constraint — this one caught a test fixture that went around the service |
| Due date can never pass its external deadline | CHECK constraint |
| Activity log is append-only | Withheld `GRANT`s |
| Notifications point at real tasks | Foreign key, added in Stage 12 when its absence was discovered |

## Permissions

> **Capability** grants the ability. **Relationship** grants the scope.

"May reassign tasks" is a capability. "…but only on engagements she manages, or for her reports" is a relationship. Both are checked, always. **No role name is compared anywhere in the codebase** — an organisation can rename or restructure its roles without a code change.

Visibility is a **union of relationships** — assignee, contributor, reviewer, creator, engagement member, line manager, engagement partner, client relationship partner — not an org-chart walk. This is what makes cross-team staffing work: a tax senior can be put on an audit engagement without breaking either the org chart or the permission model.

**Being given one task is not the same as joining the engagement.** Assignment attaches the assignee to the engagement as an `OBSERVER`, and an observer membership grants no engagement-wide read: they reach their own task through the assignee relationship and see nothing else there. Every other capacity — Member, In-charge, Manager, Partner — is a working membership and does see the whole engagement. An existing membership is never downgraded by a later assignment.

Unauthorised reads return **404, never 403**. A 403 confirms the record exists, which is what someone probing IDs is trying to learn. Verified in the browser: a real-but-unauthorised user id and a nonexistent one produce byte-identical pages.

## Working features

| Area | What works |
|---|---|
| **Task lifecycle** | Create, assign, update, transition, block, cancel, reopen. Optimistic locking on every write; the activity log written in the same transaction as the change it records |
| **My Work** | One prioritised list — overdue → sent back → due today → awaiting review → blocked → this week → later. Not four widgets. Below it, "Waiting on someone else": work you asked a colleague for, kept out of the priority bands and out of every workload figure |
| **Cross-department requesting** | Any employee may create work on an engagement they belong to and assign it to anyone active, whatever team they are in. The requester gains no authority over it — no reassign, deadline, priority, cancel, or time logging |
| **Quick create** | Four visible fields, `N` to open, Ctrl+Enter to save, stays open for creating in runs. The assignee picker shows current load, so overload is visible *at the moment of delegation* |
| **Task detail** | Description, people, dates, estimate vs actual, subtasks, and the full history rendered as plain sentences |
| **Status workflow** | Only transitions the kernel permits are rendered. Reasons are dialogs, not skippable fields. Conflicts offer reload, never silent retry |
| **Comments** | 15-minute author edit window, then fixed. Nobody may edit another person's words — manager included. Removal leaves a tombstone; the original text goes to the activity log |
| **Mentions** | Filtered to people who can open the task, so a crafted request cannot ring a bell for work someone has no key to |
| **Time tracking** | Server-owned timer surviving reloads, tabs and devices. Manual entry as a first-class path. A duration field that echoes back what it understood |
| **Timesheet** | Weekly grid, because the *empty days* are the point — a list hides gaps, a grid makes a blank Wednesday obvious. Managers can read the sheets of people they oversee |
| **Forgotten-timer watchdog** | `npm run watchdog`. Suspends rather than guessing — a suspended entry counts toward nothing until its owner says what they actually worked |
| **Notifications** | A panel in the header. Assigned, sent back, mentioned, deadline moved, added as contributor. Nothing else |
| **Team dashboard** | What's at risk, where the load is, what each client is absorbing |
| **Browse** | Full-text search over titles and descriptions, plus filters that live in the URL — a filtered view is a link you can send. The search is scoped to what you may see *before* its row cap applies, so your own matching work cannot be pushed out by the rest of the firm's |
| **"Asked by"** | Team and Browse rows name who requested the work as well as who is doing it — but only when it is news, so nothing shows on your own requests or on work someone gave themselves |
| **Clients** | The map of clients and engagements, scoped by the work you can actually see |
| **Reports** | Where the hours went, over any range, with a two-sheet spreadsheet whose Detail rows sum to its Summary total |

## Configurable without code changes

The CA firm is **seed data, not code**. There is no `if (organisation is a CA firm)` anywhere.

| Configurable | Where |
|---|---|
| Name, logo, timezone, date format, working week, week start | `organizations` row |
| Task key prefix, search language | same |
| Roles and the capabilities each holds | `roles` rows |
| Vocabulary — Client/Customer, Engagement/Project, Statutory/SLA | `organizations.terminology` |

Demonstrated rather than asserted: `prisma/sql/examples/` holds two runnable configurations. Applying the software-company one turns "Clients" into "Customers" and "STAT" into "SLA" with no code change.

## Not built

| | |
|---|---|
| **Email notifications** | Blocked by a deliberate decision — Microsoft Graph was excluded from the Entra registration, so mail needs a second approval round. The engine is channel-agnostic; `notifications.email_sent_at` is the seam |
| **Security and load testing, deployment** | Stage 16 |
| **Weekly timesheet approval** | **Out of scope**, decided 31 August 2026. Not designed-and-pending: it will not be built in this release. Hours are recorded and never formally confirmed by anyone, which is the honest limitation to state |
| **Configurable statuses** | Design settled (organisation-chosen label plus engine-owned category), deferred while all status logic funnels through one file |
| **Recurring tasks** | Schema and rules exist; the generation job does not |
| **Attachments** | Schema exists; Azure Blob wiring does not |
| **Admin CRUD** | No screens for managing users, roles, clients, engagements or engagement membership. `manage.work_areas` is granted to Partner and checked nowhere. Membership is written only as a side-effect of assignment, or by the seed |
| **Tag management** | Tags are seeded, indexed for search and filterable, but there is no screen to create one or attach it to a task |

Previously listed here and **since built**: filtering and search UI (Stage 14),
reports and Excel export (Stage 15), and the nav links that used to 404 —
`/clients`, and the browse screen, which shipped as `/browse` rather than the
`/tasks/all` this document originally named (Stage 14).

---

## Known risks

| Risk | Standing |
|---|---|
| **Adoption** | If logging time takes more than ~20 seconds a day, the system is abandoned. The largest risk and not a technical one |
| **Punitive use of the data** | If estimates or hours feed appraisals, data quality collapses within a quarter. The product deliberately builds no screen that ranks people |
| **Missing estimates** | A workload figure that silently omits unestimated work is how managers stop trusting the screen — and they only stop once. Every figure states what it could not count |
| **A bare number in the time field means hours** | So "45" meaning 45 minutes becomes 45 hours. Large slips are refused; a bare "5" becomes five hours and is plausible. Mitigated by the field echoing its interpretation as you type — watch whether real users still get caught |

## Technical debt

- ~~`package.json#prisma` is deprecated; must move to `prisma.config.ts` before Prisma 7~~ — **done 31 August 2026.** Moved to `prisma.config.ts`, which must call `process.loadEnvFile()`: a config file makes the CLI stop loading `.env`, and without it every Prisma command fails with P1012. Needs Node 20.12+
- ~~Four unused dependencies to remove before deployment~~ — **done 31 August 2026.** Removed; see "Declared but not yet used" above
- Test fixtures rebuild per test (~35s for the largest suite); batching the inserts would cut most of it
- 7 npm audit findings in transitive dependencies, for Stage 16
- Historical team reports would follow the *current* reporting line, not the line as at the time
- `stalledReview` on the dashboard uses `updatedAt` as a proxy for "entered review" — good enough to surface a queue nobody is serving, not good enough to quote in a report
