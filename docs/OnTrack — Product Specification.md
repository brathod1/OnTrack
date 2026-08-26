# OnTrack — Internal Work & Time Management System
## Product Specification v1.0 (for approval)

**Prepared for:** K C Mehta & Co LLP
**Context:** CA firm, 20–100 staff · Microsoft Azure / M365 · Entra ID SSO
**Status:** Specification for review. No code written yet.
**Date:** 26 August 2026

---

# 0. Executive summary — and where I disagree with the brief

The brief describes a generic task tracker. That is not what this firm needs, and building it would produce a system that is abandoned within two months. Below is the specification for what I think you should actually build, followed by an honest account of what I have changed, added, cut and deferred.

**The eleven judgements that shape this design:**

| # | Judgement | Why it matters |
|---|---|---|
| 1 | **Work is Client → Engagement → Task, not Department → Project → Task** | In a CA firm, work exists because a client engaged you. A "project" that does not roll up to a client cannot answer "how many hours did we spend on ABC Ltd's statutory audit?" — the single most valuable question this system can answer. Department is an attribute of *people*, not of *work*. |
| 2 | **Clients and engagements are V1, not V2** | The brief asks whether clients belong in V1. Without them the system is a to-do list. With them it is a practice-management asset. This is non-negotiable. |
| 3 | **Visibility is a matrix, not a tree** | A senior reports to one line manager but works under four engagement managers at once. "Managers see their team's tasks" breaks on day one. Access = union of *line management* + *engagement membership* + *role*. This is the biggest correction to the brief. |
| 4 | **One accountable assignee per task** | Multiple assignees destroy accountability and make workload arithmetic impossible (whose eight hours are these?). Use subtasks for shared work and watchers for interest. |
| 5 | **Recurrence is core, not advanced** | Roughly 60–70% of a CA firm's task volume is statutory and repeating — GSTR-1 on the 11th, GSTR-3B on the 20th, TDS quarterly, advance tax, ITR, audit. If someone must hand-create 400 tasks each month, the system dies. A recurrence engine ships in V1. |
| 6 | **Blocked is a flag, not a status** | Making Blocked a status loses the information about *where* the work actually was. A blocked task is still In Progress with an impediment. Flag + reason + expected-unblock date. |
| 7 | **Time entries are the source of truth; `actual_time` is a cache** | Never let a task carry an authoritative hours number that can drift from its entries. |
| 8 | **Weekly timesheet approval, not per-entry approval** | Per-entry manager approval sounds rigorous and is never actually done in a 50-person firm; managers rubber-stamp it. Weekly submit → approve → period lock is the granularity that gets genuinely reviewed. |
| 9 | **Estimate accuracy must never enter an individual's appraisal** | The moment estimates are scored, everyone pads them, and within one quarter your estimate data is worthless — destroying the very capability the brief asks for (Q14, "how accurate are our time estimates?"). Estimate accuracy is a *team-level planning* metric. This is a governance policy the system must enforce by design, not just a feature. |
| 10 | **No Elasticsearch, no Redis, no microservices** | At 100 users and perhaps 250,000 tasks over five years, PostgreSQL full-text search and a Postgres-backed job queue are comfortably sufficient. Every extra moving part is an operational tax on a firm with no dedicated DevOps team. |
| 11 | **The whole system lives or dies on whether logging time takes under 20 seconds a day** | Every UX decision below is subordinate to this. Adoption is the #1 risk; it is not a technical risk. |

**What I have cut from the brief:** task dependencies (V3), Kanban drag-and-drop (V2), calendar view (V2), threaded comment replies (never), a stored `remaining_time` field (derive it), separate Department *and* Team entities (one entity), a global "Viewer" role (replaced by scoped Observer).

**What I have added that the brief omitted:** leave and capacity calendar, statutory deadline vs internal target date, review rounds and rework tracking, timesheet periods and locking, article-assistant handling, leaver offboarding and work reassignment, an explicit anti-gaming metrics policy, timer watchdog for forgotten timers, and DPDP Act 2023 obligations for employee personal data.

---

# 1. Product overview

**OnTrack** is the firm's single system of record for *who is doing what work, for which client, by when, and how long it actually took*.

It is deliberately **not**:

- a billing or WIP system (V1 records billable flags but does not invoice — see §23, Risk 11)
- a document management system (attachments only; the DMS stays where it is)
- a CRM
- a generic enterprise PM tool

**Primary users, in order of how often they touch it:**

1. **Team members** (executives, seniors, article assistants) — open it several times a day, mainly to see their queue, change a status, and log time.
2. **Managers** — open it daily to see team load, review submitted work, and reassign.
3. **Partners** — open it weekly for client and engagement rollups.
4. **Admin** — occasional configuration.

**Success criteria at 6 months post-launch:**

- ≥ 90% of staff log time for ≥ 90% of working days
- Median time from opening the app to a logged time entry < 20 seconds
- ≥ 95% of client work sits under a defined engagement
- Partners can answer "what is the status of client X's work?" without asking anyone

---

# 2. Organisation model

## 2.1 The corrected hierarchy

The brief proposes `Organization → Department → Project → Task → Subtask`. This conflates two independent hierarchies. Separate them:

```
PEOPLE                              WORK
──────                              ────
Firm                                Client
 └── Team (service line)             └── Engagement          (e.g. "Statutory Audit FY 2025-26")
      └── User                            └── Task
           ↑ reports_to (line manager)         └── Subtask (one level only)
```

The two are joined by **engagement membership** — a many-to-many table saying which users work on which engagement, in what capacity (Partner / Manager / In-charge / Member / Observer).

**Why this is better:** a Tax team member can be pulled onto an Internal Audit engagement without breaking the org chart or the permission model. In the brief's model that person either has to change department or the manager cannot see their work.

## 2.2 Team, not Department

For 20–100 people, modelling both Department *and* Team is over-engineering. Use one entity — **Team**, representing a service line:

> Statutory Audit · Internal Audit & Risk · Direct Tax · Indirect Tax / GST · Transaction Advisory · Corporate Law & Secretarial · Internal Admin

Add an optional `office` field on the user for multi-location. If the firm crosses ~200 people or three offices, promote Team into a two-level tree (V2, one migration, low cost).

## 2.3 Non-client work

Not everything is billable to a client. Create one internal pseudo-client, **"Firm — Internal"**, with standing engagements: *Practice Administration, Training & CPE, Business Development, Leave & Non-productive*. This keeps one code path — every task has an engagement, always — and makes utilisation computable without special-casing.

## 2.4 Article assistants

Articled clerks are a distinct population: lower capacity, mandatory review on everything they touch, and long absences for exam leave. Model as a `user.grade` (Partner / Director / Manager / Assistant Manager / Senior / Executive / Article) which drives default capacity hours and whether review is mandatory by default. Do not model them as a separate role.

---

# 3. User roles and the permission model

## 3.1 Why the brief's four roles are insufficient

Admin / Manager / Member / Viewer is a *flat* model. Real questions it cannot answer:

- A senior on the Tax team is the in-charge on one engagement and a junior member on another. Can she reassign tasks? *It depends which engagement.*
- A partner needs to see everything for her clients, and nothing for another partner's clients.
- The HR manager needs everyone's leave and no one's client work.
- An external consultant needs one engagement and nothing else.

The fix: **role gives capability, scope gives reach.** A permission check is always `(capability, scope)`.

## 3.2 Roles (global capability level)

| Role | Who | Capability ceiling |
|---|---|---|
| **Admin** | 1–2 people (IT / practice manager) | Everything, including configuration, user lifecycle, period unlocking, audit log read. **Cannot** silently edit others' time entries — edits are always attributed and logged. |
| **Partner** | Partners | Full read/write across every engagement where they are the engagement partner; read across the firm's aggregate reports; approve timesheets. |
| **Manager** | Managers, Assistant Managers | Full read/write on engagements they are a member of; read/write on direct and indirect reports' tasks; assign, reassign, change deadlines, review, approve timesheets. |
| **Member** | Seniors, executives, articles | Read/write their own tasks; read all tasks on their engagements; comment; log time; create tasks (configurable per team). |
| **Observer** | Not a global role — a *per-engagement* membership capacity | Read-only on one engagement. Used for external consultants, cross-team stakeholders, and trainees. |

The brief's "Viewer" is genuinely useful but should be scoped, not global. A global read-only role has exactly one legitimate use — the firm's own IT auditor — and that is better served by a time-boxed Admin grant with audit logging.

## 3.3 Scopes

| Scope | Definition |
|---|---|
| `self` | Records where the user is assignee, creator, or time-entry owner |
| `reports` | Transitive closure of `reports_to` beneath the user |
| `engagement` | Engagements where the user has an active membership |
| `client` | All engagements of clients where the user is the relationship partner |
| `team` | Users whose primary team matches |
| `firm` | Everything |

## 3.4 Permission matrix

`✓` allowed · `○` allowed within named scope · `—` denied

| Capability | Admin | Partner | Manager | Member | Observer |
|---|---|---|---|---|---|
| View task | ✓ | ○ client + engagement | ○ engagement + reports | ○ engagement + self | ○ engagement |
| Create task | ✓ | ○ engagement | ○ engagement | ○ engagement *(if team setting allows)* | — |
| Edit task core fields | ✓ | ○ engagement | ○ engagement | ○ self (title, description, status, ETC only) | — |
| Assign / reassign | ✓ | ○ engagement | ○ engagement + reports | — *(may self-claim from backlog)* | — |
| Change due date | ✓ | ○ engagement | ○ engagement, **within statutory ceiling** | — *(may request change)* | — |
| Change estimate | ✓ | ○ engagement | ○ engagement | ○ self, **before work starts only** | — |
| Change priority | ✓ | ○ engagement | ○ engagement | — | — |
| Delete / cancel task | ✓ | ○ engagement | ○ engagement | — | — |
| Comment | ✓ | ○ | ○ | ○ | ○ *(configurable)* |
| Upload attachment | ✓ | ○ | ○ | ○ | — |
| Log own time | ✓ | ✓ | ✓ | ✓ | — |
| Edit own time (open period) | ✓ | ✓ | ✓ | ✓ | — |
| Edit others' time | ✓ *(logged)* | ○ engagement *(logged)* | ○ reports *(logged)* | — | — |
| Submit timesheet | ✓ | ✓ | ✓ | ✓ | — |
| Approve timesheet | ✓ | ○ reports | ○ reports | — | — |
| Unlock a locked period | ✓ | — | — | — | — |
| Review / approve work | ✓ | ○ engagement | ○ engagement | ○ *if named reviewer* | — |
| Reopen completed task | ✓ | ○ engagement | ○ engagement | — | — |
| View team workload | ✓ | ○ client + firm rollup | ○ team + reports | ○ **own only** | — |
| View another person's time detail | ✓ | ○ engagement | ○ reports | — | — |
| Run reports | ✓ | ○ client + firm | ○ team + engagement | ○ self | — |
| Export data | ✓ | ○ *(logged)* | ○ *(logged)* | ○ self *(logged)* | — |
| Manage users / teams / clients | ✓ | — | — | — | — |
| Read audit log | ✓ | ○ own engagements | — | — | — |

**Three deliberate calls in this matrix:**

- **Members cannot see colleagues' workload.** Individual hours-logged comparisons between peers are corrosive and generate no management value that the manager's view doesn't already give. Own workload only.
- **Members cannot change their own due dates or priority.** They can *request* a change, which notifies the manager and is logged. Otherwise deadlines are meaningless.
- **Members can set their own estimate only before work starts.** After the first time entry, the original estimate freezes for accuracy measurement; further revisions go into `estimate_to_complete` (ETC), which is separate and freely editable.

## 3.5 Enforcement — the answer to "must not be accessible by changing the URL"

This is an architectural rule, not a feature:

1. **A single authorisation kernel.** One module exports `canRead(user, entity)`, `canWrite(user, entity, field)` and, critically, `visibleTaskScope(user) → SQL predicate`. Every list query composes that predicate; every fetch-by-id runs the row check *after* loading and returns **404, not 403**, on failure (a 403 confirms the record exists — an information leak).
2. **No authorisation logic in React components.** UI hiding is cosmetic only. Every mutation re-checks server-side.
3. **Attachments never have public URLs.** Files live in a private Azure Blob container. Download issues a 5-minute user-bound SAS token, generated only after the same `canRead` check on the parent task. Every download is logged.
4. **Contract tests.** An automated suite asserts, for a fixture org, that each role sees exactly the expected row set on every list endpoint. This runs in CI and is the regression net for the whole permission model.
5. **IDs are non-enumerable.** Internal PKs are `bigint`; external references use a ULID/`TSK-2026-04127` display key. Enumeration should be useless anyway because of (1), but defence in depth is free here.

---

# 4. Task lifecycle

## 4.1 Recommended states

The brief proposes seven states. I recommend **six**, with Blocked demoted to a flag:

```
   ┌─────────┐   assign    ┌────────┐   start    ┌─────────────┐  submit  ┌───────────┐ approve ┌──────┐
   │ BACKLOG │ ──────────► │ TO DO  │ ─────────► │ IN PROGRESS │ ───────► │ IN REVIEW │ ──────► │ DONE │
   └─────────┘             └────────┘            └─────────────┘          └───────────┘         └──────┘
        │                       │                    ▲     │                    │                   │
        │                       │                    │     └────────────────────┘  reject           │
        │                       │                    └───────────────────────────────────────────────┘
        │                       │                                   reopen
        └───────────────────────┴──────────────────► CANCELLED ◄────────────────────────────────────┘

   ⚑ BLOCKED  — an orthogonal flag, settable on TO DO / IN PROGRESS / IN REVIEW
```

| State | Meaning | Counts toward workload? |
|---|---|---|
| **Backlog** | Exists, scoped, not yet assigned or not yet committed to a period | No |
| **To Do** | Assigned to a person with a due date; not started | Yes |
| **In Progress** | Work has begun (auto-set on first timer start) | Yes |
| **In Review** | Submitted by the doer, awaiting reviewer | Yes — for the *reviewer*, not the doer |
| **Done** | Reviewed and accepted, or completed where review is not required | No |
| **Cancelled** | Terminal, with mandatory reason | No |

## 4.2 Why Blocked is a flag

If Blocked is a status, then when work resumes you have lost whether it was In Progress or In Review, and every report has to special-case it. As a flag it carries `blocked_reason`, `blocked_by_user` (optional — often "waiting on client"), `blocked_since`, `expected_unblock_date` — and produces the genuinely useful manager view: *"work stalled >5 days, and who is holding it up."* That view is far more actionable than a Blocked column.

## 4.3 Review is configurable, not hardcoded

The brief asks whether review should be configurable. Yes — resolved at task creation from a three-level cascade:

`task.review_required` ← explicit setting, else `engagement.default_review_policy`, else `team.default_review_policy`

Sensible defaults: **required** for all client-deliverable work and for anything assigned to an Article; **not required** for internal admin. Where required, a `reviewer_id` must be set before the task can leave In Progress. Rejection requires a comment, returns the task to In Progress, and increments `review_round` — which is your rework metric and far more honest than any "quality score".

## 4.4 Transitions are server-enforced

A transition table defines `(from, to, required_role_scope, required_fields, side_effects)`. The API rejects anything not in it. Examples:

- `To Do → In Progress` — side effect: set `actual_start_date` if null
- `In Progress → In Review` — requires `reviewer_id`; requires at least one time entry (a task completed with zero logged hours is almost always a data-quality error — warn, allow with a reason)
- `In Review → Done` — actor must be the reviewer or above; sets `completion_date`
- `Done → In Progress` (reopen) — Manager+, requires reason, increments `reopen_count`, notifies the original assignee
- `* → Cancelled` — Manager+, requires reason; time entries are retained, never deleted

## 4.5 Reassignment

Reassignment is a first-class event, not a field edit. It: updates `assignee_id` and `assigned_by_id`, stamps `assigned_at`, writes an activity record with old and new assignee, notifies both, and — importantly — **leaves existing time entries attached to the original person**. Hours belong to whoever worked them, permanently.

---

# 5. Task data model

## 5.1 Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | bigint PK | — | Internal |
| `display_key` | text unique | — | `TSK-2026-04127`, human-quotable |
| `title` | text | **Yes** | ≤ 200 chars |
| `description` | text (markdown) | No | |
| `engagement_id` | FK | **Yes** | Carries client and service line — never store `client_id` on the task |
| `parent_task_id` | FK self | No | One level of nesting only |
| `created_by_id` | FK user | **Yes** | Immutable |
| `assigned_by_id` | FK user | No | Mutable; last delegator |
| `assignee_id` | FK user | No | Null only in Backlog |
| `reviewer_id` | FK user | Conditional | Required when `review_required` |
| `status` | enum | **Yes** | §4.1 |
| `priority` | enum | **Yes** | Critical / High / Normal / Low — default Normal |
| `is_blocked` + `blocked_reason` + `expected_unblock_date` | flag set | No | §4.2 |
| `category_id` | FK | No | Firm-configurable work type |
| `tags` | M2M | No | Free-form |
| `due_date` | date | **Yes** *(once assigned)* | The commitment |
| `due_date_type` | enum | **Yes** | `statutory` / `client_committed` / `internal` — see §5.3 |
| `target_date` | date | No | Internal buffer date, always ≤ `due_date` |
| `planned_start_date` | date | No | Drives forward capacity planning |
| `actual_start_date` | timestamptz | auto | First transition to In Progress |
| `completion_date` | timestamptz | auto | |
| `original_estimate_minutes` | int | **Yes** *(once assigned)* | **Frozen** at first time entry |
| `current_estimate_minutes` | int | auto | Manager-revisable; used for planning |
| `etc_minutes` | int | No | Assignee's estimate-to-complete |
| `actual_minutes` | int | derived | Cached sum of time entries |
| `is_billable` | bool | **Yes** | Defaults from engagement. Not used in V1; enables V3 billing without migration |
| `review_round` | int | auto | Rework counter |
| `reopen_count` | int | auto | |
| `recurrence_id` | FK | No | Set on generated instances |
| `created_at` / `updated_at` | timestamptz | auto | `updated_at` also serves optimistic locking |
| `deleted_at` | timestamptz | No | Soft delete only |

**Deliberately excluded:** `remaining_time` (a stored remainder is a third number that inevitably contradicts the other two — derive `max(0, current_estimate − actual)` for display, and prefer the assignee's ETC where present); `department_id` (comes via engagement); `client_id` (comes via engagement); `actual_time` as an editable field (it is a cache of time entries).

## 5.2 "Created by" vs "assigned by" — the brief asks; here is the answer

**Keep both.** They diverge more often than people expect:

- A recurrence job creates 400 tasks in April — `created_by` = *System*, and each has a different `assigned_by`.
- A partner's EA creates the tasks; the partner is the one delegating.
- Task is reassigned twice — `created_by` never changes, `assigned_by` changes each time.

`created_by` is immutable provenance. `assigned_by` answers "who put this on my plate", powers the saved view *"Tasks I assigned"*, and determines who gets notified on completion. Technically `assigned_by` is derivable from the activity log, but denormalising it is worth it — that view is queried constantly and a log scan per row would be wasteful.

## 5.3 Due date vs target date — an addition to the brief

A CA firm's deadlines are not homogeneous. A GSTR-3B due 20 September is immovable and carries statutory consequences. An internal review target is not. Treating them as the same field makes "overdue" a meaningless noise generator, and users will start ignoring the overdue badge — which destroys the feature.

So: `due_date_type` drives escalation, colour, and whether a manager may push the date. Managers **cannot** move a `statutory` due date past its ceiling (held on a firm-wide statutory calendar); they can move `internal` dates freely with a logged reason.

## 5.4 Subtasks

Subtasks are **rows in the same `tasks` table** with `parent_task_id` set. One code path, one permission model, one time-tracking path. **Depth is capped at one level** — deeper trees are consistently unusable in practice and make progress arithmetic opaque.

**Parent progress — do not auto-set the parent's status.** Auto-status is the classic mistake: the parent flips to Done because the last subtask closed, while the parent's own wrap-up work is still outstanding. Instead:

- Display progress as `n/m subtasks complete`, and where estimates exist, an estimate-weighted percentage.
- **Block** the parent from moving to Done while open subtasks remain — overridable by Manager+ with a reason.
- **Workload sums leaf tasks only.** A parent's own estimate covers only its own work; the roll-up total is displayed separately and never added into capacity, or every hour is counted twice. This is a real and common bug.

---

# 6. Time tracking

The most important subsystem, and the one most likely to be got wrong.

## 6.1 Principles

1. **`time_entries` is the ledger.** `task.actual_minutes` is a cache updated in the same transaction.
2. **The server owns the clock.** A running timer stores `started_at` server-side; the browser only renders elapsed time. Timers therefore survive a closed tab, a dead laptop, a browser crash, and a second device. Client clocks are never trusted.
3. **Work date is a date, not a timestamp.** `work_date` is a plain local date, separate from `created_at`. Someone logging Friday's work on Monday must be able to date it Friday, and no report should shift because of UTC conversion.
4. **Nothing is ever hard-deleted.** Edits and deletions are soft, attributed, and logged with before/after values.

## 6.2 Time entry

| Field | Notes |
|---|---|
| `id`, `task_id`, `user_id` | |
| `work_date` | date (local) — what the reports group by |
| `started_at` / `ended_at` | timestamptz, null for manual entries |
| `duration_minutes` | int, always populated; authoritative |
| `source` | `timer` / `manual` / `adjustment` |
| `note` | Optional; **required** if duration > 8h in one entry |
| `is_billable` | Defaults from task |
| `period_id` | FK to `timesheet_periods` |
| `edited_by_id`, `edited_at`, `edit_reason` | Populated only when someone other than the owner edits |
| `deleted_at`, `deleted_by_id`, `delete_reason` | Soft delete |

## 6.3 The running timer — every edge case the brief raises

- **One running timer per user, enforced in the database** with a partial unique index: `CREATE UNIQUE INDEX ON time_entries (user_id) WHERE ended_at IS NULL AND source = 'timer'`. Application-level checks race; the index cannot.
- **Starting a second timer** presents "You're currently timing *[Task]* (1h 12m). Stop it and start this one?" On confirm, both actions happen in one transaction. No silent stop, no two timers.
- **Forgotten timers.** A watchdog job runs nightly. Any timer running past a firm-configured ceiling (default 10 hours) is **suspended, not auto-logged**. Next login the user sees: *"You left a timer running on TSK-04127 from 6:12pm yesterday. How long did you actually work?"* with quick options. Silently writing 14 hours is worse than writing nothing — it poisons the estimate data and the user loses trust in every number in the system.
- **Timer running when the task is reassigned or cancelled** — the timer stops automatically, the entry is retained against the original user, and the user is notified.
- **Overlapping entries.** Timer entries cannot overlap for the same user (the index plus an exclusion constraint on the `[started_at, ended_at)` range). Manual entries *may* overlap — sometimes legitimately (a review call covering two tasks) — but overlaps are surfaced in the timesheet as a warning to confirm.
- **Sanity guardrails:** > 16h on one work_date blocks submission; > 8h single entry requires a note; future-dated entries rejected; entries more than 30 days back require manager approval.
- **Offline / poor connection:** the start action is optimistic in the UI but reconciled against the server timestamp on reconnect. Server value always wins.

## 6.4 Manual entry — and why it must be first-class

Purists want timer-only. In practice, staff work in client offices, on calls, and on paper, and a timer-only system produces *less* accurate data because the day gets reconstructed from memory anyway — just without a UI for it. So: a **weekly grid** (rows = tasks, columns = Mon–Sun, cells = hours) is the primary bulk-entry surface, alongside the timer for people who prefer it. This grid is the single highest-leverage screen in the product for adoption.

## 6.5 Timesheet periods and locking — replacing per-entry approval

The brief asks whether time entries should be locked after approval. Yes, but at **period** granularity:

```
OPEN  →  SUBMITTED  →  APPROVED  →  LOCKED
 ▲            │            │
 └────────────┴────────────┘  (reject / unlock)
```

- Weeks are the default period (configurable to fortnight/month).
- Staff submit by Monday noon for the prior week; reminder Friday 4pm, escalation to manager Tuesday.
- Manager approves or rejects the **week**, with comments. Approval is a real review of ~40 hours, not 30 rubber-stamped clicks.
- Approved periods lock at month end. **Only Admin can unlock**, with a reason, and the unlock is logged and visible on the period forever.
- Once locked, an error is corrected by an `adjustment` entry in the current period referencing the original — the same discipline as a ledger. No retrospective rewriting of closed periods.

## 6.6 Capacity — an addition the brief omits

You cannot say who is overloaded without knowing who is available. V1 needs a minimal availability model:

- `working_calendar` — firm holidays, weekends, and half-days
- `user_capacity` — standard hours/day by grade (Article 7.0, Executive 7.5, Manager 6.0 with the balance assumed for review/admin)
- `leave` — approved absences (dates + type). Article exam leave is 6–8 weeks and will otherwise wreck every capacity number in Q4.

If HR already holds leave elsewhere, import it nightly rather than duplicating data entry.

---

# 7. Activity history and audit

## 7.1 Two logs, not one

The brief treats these as one thing. They have different consumers and different retention rules:

| | **Activity feed** | **Audit log** |
|---|---|---|
| Purpose | "What happened on this task" — human narrative | Compliance and forensics |
| Scope | One task | Every entity, every security event |
| Visible to | Anyone who can read the task | Admin (and Partner, for own engagements) |
| Mutability | Append-only | Append-only, **DB-enforced** |
| Retention | Life of the task | 7 years |
| Includes | Comments, status, assignment, dates, time, attachments | The above **plus** logins, permission changes, failed authorisation, exports, downloads, period unlocks, user deactivation |

The activity feed can be a *projection* of the audit log filtered to one task — one write path, two read models.

## 7.2 Immutability — the brief asks; yes

The application's database role is granted `INSERT` and `SELECT` on `audit_log` and explicitly **not** `UPDATE` or `DELETE`. Combined with append-only partitioning by month and daily off-site backup, that is proportionate assurance for a firm this size. Full hash-chaining is available if the firm's own internal audit function wants it, but I would not build it in V1 — it adds real cost for a threat (a DBA silently editing history) better addressed by restricting who holds DBA credentials.

## 7.3 Record shape

`actor_id · acted_at · entity_type · entity_id · action · field · old_value (jsonb) · new_value (jsonb) · request_id · ip · user_agent · reason`

`reason` is mandatory for: deadline change, reopen, cancel, others' time edit, period unlock, permission grant.

## 7.4 Events tracked

Created · assigned · reassigned · status changed · priority changed · due date changed *(with old/new and reason)* · estimate changed · blocked/unblocked · comment added/edited/deleted · attachment added/removed/downloaded · timer started/stopped · time entry created/edited/deleted · submitted for review · approved · rejected *(with reason)* · completed · reopened · cancelled · exported · permission changed.

**Not logged:** views. Read-logging every task open generates enormous volume for negligible value. Log reads only for attachment downloads and report exports, where the data actually leaves the system.

---

# 8. Comments and collaboration

**Design stance: keep this small.** Task discussion in a 50-person firm is short and operational. Over-building it produces a bad chat app competing with Teams, which the firm already has.

**V1:**

- Flat comment list, markdown, chronological. **No threading** — at this volume threads fragment the record and make the audit trail harder to read.
- `@mentions` with autocomplete restricted to users who can already see the task (mentioning someone who cannot read the task prompts to add them as a watcher, with permission check).
- Inline attachments.
- Edit within **15 minutes**, then frozen; the edit is flagged with "edited" and the original is retained in the audit log.
- Delete = soft delete leaving a tombstone ("Comment removed by X"). Comments are part of the work record; silent disappearance is unacceptable in a professional services firm.
- **Watchers** — anyone with read access can follow a task; assignee, reviewer, assigner, and the engagement manager are auto-watchers.

**Explicitly not in V1:** reactions, rich text beyond markdown, threaded replies, comment search ranking (plain full-text is enough).

---

# 9. Dashboards

Design rule: **every element must answer a question the user would otherwise have to ask a colleague.** Anything that fails that test is decoration.

## 9.1 "My Work" (all users) — the default landing page

The single screen most staff will live in. It must load in under one second and require zero configuration.

- **Top strip:** running timer (or a prominent Start button), hours logged today, hours logged this week vs expected.
- **Focus list**, in this order, as one list rather than four widgets: **Overdue** → **Due today** → **In review, rejected back to me** → **Due this week** → **Blocked (mine)**. A single prioritised list beats four boxes the user has to mentally merge.
- Each row: client · engagement · title · due date · estimate vs logged · one-click timer · inline status change.
- **Right rail:** unsubmitted timesheet warning, @mentions, tasks awaiting *my* review.

**Not included:** completed-task counts, charts of my own history, gamified streaks. Nobody needs their own scoreboard at 9am, and it invites gaming.

## 9.2 Manager dashboard

Answers: *Is anything about to go wrong, and who needs help?*

- **Exceptions first, in one ranked list:** overdue by days late · due within 48h and not started · blocked > 3 days · in review > 2 days *(the manager's own bottleneck — this one is uncomfortable and important)* · tasks with actual > 150% of estimate and still open · no time logged in 5 days on an in-progress task.
- **Team capacity strip:** one row per person — committed hours next 7 days vs available hours, coloured, sorted by over-commitment. Not a task count. §10.
- **Engagement health:** for each active engagement — % complete by estimate, hours logged vs budget, days to deadline, open exceptions.
- **Awaiting my action:** reviews queued, timesheets to approve, reassignment requests, deadline-change requests.

**Not included:** pie charts of task status, "tasks completed this month" bar charts, individual leaderboards. None change a decision.

## 9.3 Partner dashboard

- Client portfolio: engagements by status, hours vs budget, deadline risk
- Statutory calendar: next 30 days of filings across the portfolio with readiness status
- Firm-level: overdue rate trend, capacity utilisation by team, engagements at risk
- Drill-down to engagement, then task

---

# 10. Workload and "who is overloaded"

**Task count is not workload.** Someone with 40 trivial tasks may be fine; someone with three statutory audits is drowning. The brief flags this correctly. The right model:

```
committed_hours(user, horizon) =
    Σ over open tasks assigned to user, where due_date ≤ horizon:
        COALESCE(etc_minutes, current_estimate_minutes − actual_minutes, current_estimate_minutes)
        ... leaf tasks only
    + review_load(user, horizon)      // tasks awaiting this user's review

available_hours(user, horizon) =
    working_days(horizon) × capacity_hours(user.grade)
    − approved_leave_hours
    − firm_holidays

load_ratio = committed_hours / available_hours
```

**Bands:** < 0.7 has room · 0.7–1.0 healthy · 1.0–1.25 tight · > 1.25 overloaded · > 1.25 **with a statutory deadline inside the horizon** = escalate.

**Two refinements that matter:**

- **Deadline-weighted, not flat.** 40 hours due Friday is a crisis; 40 hours due in three weeks is not. Compute over rolling 7-day and 30-day horizons and show both.
- **Priority-aware.** Show Critical/High hours separately, because those cannot be deferred.

**Honest caveats to display in the UI, not bury:** load is only as good as the estimates behind it; tasks with no estimate are excluded and their count is shown alongside every load figure ("*3 tasks unestimated*"). Presenting a confident number built on missing data is the fastest way to lose the managers' trust.

---

# 11. Reporting

## 11.1 Architecture

All reports are the **same query engine with different presets** — one filter model, one permission scope, one export path. Never hand-build twenty report screens; you will maintain twenty inconsistent permission bugs.

`report(dimensions[], measures[], filters[], date_range, grain)` → table + optional chart + export.

Every report is scoped through `visibleTaskScope(user)` before aggregation. A manager running a "firm-wide" report gets their scope's subset, clearly labelled — never a silent empty result and never someone else's data.

## 11.2 V1 report presets

| Report | Grouped by | Key measures |
|---|---|---|
| **Engagement status** | Client → Engagement | open/done/overdue, hours vs budget, % complete, deadline risk |
| **Client time** | Client → Engagement → Person | hours (billable/non-billable), by month |
| **Person workload & activity** | Person | open tasks, committed hours, load ratio, overdue, hours logged, unsubmitted timesheets |
| **Overdue register** | Client / Person / Team | days overdue, ageing buckets, due-date type, reason |
| **Estimate accuracy** | Engagement / Category / Team | median actual÷estimate, % within ±20%, tasks with no estimate — **team and category level only, never a person column** |
| **Timesheet compliance** | Person → Week | submitted / approved / missing, hours vs expected |
| **Statutory calendar** | Due date | upcoming filings, owner, readiness |
| **Rework** | Engagement / Category | review rounds > 1, reopen count, top reasons |

## 11.3 Exports

Excel (formatted, with the applied filters printed on a cover sheet — a report without its filter context is dangerous), CSV (raw), PDF (presentation, V2). Exports always reflect the **currently applied filters**, run server-side, and are written to the audit log with the row count and the filter set.

---

# 12. Metrics — which are real and which are traps

The brief asks me to be careful with "productivity". Here is the direct answer.

## 12.1 Genuinely useful

| Metric | Why it is sound | Read at |
|---|---|---|
| **On-time completion rate** | Directly measures the promise you made to a client or a statute | Team, engagement, firm — trend over quarters |
| **Overdue ageing** | Distinguishes "2 days late" from "6 weeks abandoned" | Any level |
| **Estimate accuracy (median ratio, % within ±20%)** | Improves planning; median resists outliers | **Category and team only** |
| **Rework rate** (review rounds > 1, reopens) | The closest honest proxy for quality | Engagement, category |
| **Load ratio / capacity utilisation** | Enables the intervention that actually helps: moving work | Person (for the manager), team |
| **Cycle time** (start → done, excluding blocked days) | Surfaces process friction; excluding blocked time is what makes it fair | Category, engagement |
| **Timesheet compliance** | Data quality — everything above depends on it | Person, team |

## 12.2 Misleading — and what they cause

| Metric | The failure |
|---|---|
| **Tasks completed per person** | Ignores size entirely. Rewards splitting work into many small tasks and penalises whoever takes the hard job. Guaranteed to be gamed within weeks. |
| **Hours logged, as performance** | Measures presence, not output. The single most gameable number in the system: it rewards padding and punishes the efficient. Use it for *capacity and cost*, never for *evaluation*. |
| **Composite "productivity score"** | Opaque, so nobody can improve it honestly — but everybody can find the one input that moves it. Do not build it. |
| **Individual estimate accuracy** | The self-destroying metric. Score it and estimates get padded; padded estimates make capacity planning worthless and destroy the very question the brief asks in Q14. |
| **Utilisation leaderboards** | Turns a coordination tool into a surveillance tool. Adoption collapses, and with it the data. |
| **Average completion time, unadjusted** | Dominated by blocked and waiting time that the assignee does not control. Only meaningful with blocked time excluded. |

## 12.3 The policy the system should enforce

- Individual-level views exist for **workload management by that person's own manager** — never as cross-team rankings.
- Estimate accuracy and rework are exposed only at team/category grain in V1, with no drill-down to a person column.
- If the firm later decides these belong in appraisals, that is a decision to make explicitly and communicate openly — not something that happens by accident because a screen existed. Building the guardrail in now is cheap; retrofitting trust after staff feel monitored is impossible.

---

# 13. Search, filtering and saved views

**Filters** (all combinable, URL-encoded so any view is shareable and bookmarkable): date range *(created / due / completed / worked — the field must be explicit)*, client, engagement, assignee, assigned-by, reviewer, team, status, priority, due-date type, category, tags, blocked, overdue, has-time-logged, estimate-vs-actual band.

**Saved views** — personal and firm-shared. Ship these preloaded, because users who must build their first view usually never build one:

`My overdue` · `Due this week` · `Assigned by me` · `Awaiting my review` · `Rejected back to me` · `Blocked > 3 days` · `In progress, no time logged in 5 days` · `Unestimated tasks` · `Statutory filings next 30 days` · `My team overloaded`

**Search:** PostgreSQL full-text over a generated `tsvector` covering title, description, display key, client name, engagement name, tags and comments, with a GIN index and `pg_trgm` for fuzzy client-name matching. Global search box with `⌘K`, results grouped by entity type, **always filtered through the user's visibility scope** — an unscoped search index is the most common way permission models leak in systems like this.

At the projected volume this is comfortable. Elasticsearch would add an operational dependency, a sync pipeline, and a second permission surface for no benefit. Revisit past ~2 million rows.

---

# 14. Notifications

**The design goal is that a notification is never ignored.** That means sending far fewer than the brief lists.

## 14.1 Channels

- **In-app** — everything, with a bell counter
- **Email (Microsoft Graph, from a firm mailbox)** — a deliberately short list
- **Teams** — V2, via an incoming webhook or Graph chat message
- **Push/SMS** — no

## 14.2 Defaults

| Event | In-app | Email |
|---|---|---|
| Task assigned to me | ✓ | ✓ |
| @mentioned | ✓ | ✓ |
| Review requested of me | ✓ | ✓ |
| My submitted work rejected | ✓ | ✓ |
| My task's deadline changed by someone else | ✓ | ✓ |
| Timesheet overdue (Mon 5pm, then manager on Tue) | ✓ | ✓ |
| Daily digest 08:30 — due today, overdue, awaiting my review | — | ✓ |
| Comment on a task I'm watching | ✓ | — |
| Status change on my task | ✓ | — |
| Task I assigned was completed | ✓ | — |
| Deadline approaching (T−2 days) | ✓ | — *(digest only)* |
| Anything I did myself | — | — |

## 14.3 Anti-overload rules

1. **Never notify a user of their own action.** Sounds obvious; is the most common bug in these systems.
2. **Coalesce.** Multiple events on one task within 15 minutes collapse into one notification ("3 updates on TSK-04127").
3. **Digest by default for time-based nudges.** Per-task deadline emails are how inboxes get filtered to trash — and once a user filters your domain, *all* your notifications are gone, including the important ones.
4. **Per-user preferences** with a channel matrix and quiet hours, but the defaults above must be right, because ~85% of users never open preferences.
5. **Deep-link straight to the task** with the action available on arrival.
6. **Mute a task** individually.

---

# 15. Recurring tasks

Not optional for this firm. The compliance calendar *is* the workload.

**Model:** a `recurrence_rules` row holds a task template (title pattern, engagement, default assignee, estimate, category, review policy) plus a schedule (`monthly on day N`, `quarterly`, `annual`, `every Nth weekday`, or an RRULE for odd cases) and a **due-date rule** — which is the part generic tools get wrong. For statutory work the due date is defined by law, not by an offset: *GSTR-3B is due the 20th of the following month*. So the rule expresses `period → due_date`, and generation also creates the task early enough to be worked on (`generate_lead_days`, default 10).

**Generation:** a nightly job materialises instances inside a rolling window (default 45 days). Instances are real tasks, individually editable; editing one never affects the series. Editing the *rule* affects only future ungenerated instances.

**Exceptions:** skip a period (with reason), change one instance's assignee or date, end the series (e.g. client offboarded), pause during a client's dormancy.

**Collision handling:** if the prior instance is still open when the next generates, generate anyway — the obligation exists regardless — but link them and flag `previous_instance_incomplete`. This flag is one of the best early-warning signals of a client engagement going wrong.

**Seed the firm's statutory calendar** as templates at go-live: GSTR-1, GSTR-3B, GSTR-9/9C, TDS returns (24Q/26Q/27Q), TCS, advance tax instalments, PF/ESI, ITR, tax audit, statutory audit, ROC filings (AOC-4, MGT-7), DIR-3 KYC. This is a content task as much as a code task, and it is what makes the system useful on day one instead of month three.

---

# 16. Full data model

## 16.1 Entity map

```
                          ┌──────────┐
                          │  CLIENT  │ relationship_partner → USER
                          └────┬─────┘
                               │ 1:N
                          ┌────▼───────────┐        ┌──────────────────────┐
                          │   ENGAGEMENT   │◄──N:M──┤ ENGAGEMENT_MEMBERSHIP │──► USER
                          │ fy, budget_hrs │        │ capacity, from, to    │
                          │ default_review │        └──────────────────────┘
                          └────┬───────────┘
                               │ 1:N
   ┌───────────────┐      ┌────▼─────┐ ◄─── parent_task_id (self, depth 1)
   │ RECURRENCE_   │─1:N─►│   TASK   │
   │ RULE          │      └────┬─────┘
   └───────────────┘           │
        ┌──────────────────────┼──────────────────────┬────────────────┬──────────────┐
        │ 1:N                  │ 1:N                  │ 1:N            │ N:M          │ 1:N
   ┌────▼──────┐        ┌──────▼──────┐        ┌──────▼──────┐   ┌─────▼────┐  ┌──────▼──────┐
   │ TIME_ENTRY│        │  COMMENT    │        │ ATTACHMENT  │   │   TAG    │  │  WATCHER    │
   │ → USER    │        │  → USER     │        │  → USER     │   └──────────┘  │  → USER     │
   │ → PERIOD  │        │  mentions[] │        │  blob_key   │                 └─────────────┘
   └───────────┘        └─────────────┘        └─────────────┘

   ┌──────┐  reports_to (self)      ┌──────────────┐        ┌───────────────────┐
   │ USER │──────────────┐          │ TIMESHEET_   │        │   AUDIT_LOG       │
   │ role │              │          │ PERIOD       │◄─1:N───┤ (append-only,     │
   │ grade│◄─────────────┘          │ status, lock │        │  monthly partition│
   │ team │─N:1─► TEAM              └──────────────┘        └───────────────────┘
   └──┬───┘
      ├─1:N─► LEAVE            ├─1:N─► NOTIFICATION
      ├─1:N─► SAVED_VIEW       └─1:1─► NOTIFICATION_PREFERENCE
      └─1:1─► USER_CAPACITY

   WORKING_CALENDAR (firm holidays)      CATEGORY      SETTINGS
```

## 16.2 Tables

| Table | Purpose | Key columns / notes |
|---|---|---|
| `users` | People | `entra_object_id` unique, `email`, `role`, `grade`, `team_id`, `reports_to_id`, `office`, `status` (pending/active/inactive), `deactivated_at`. Never deleted. |
| `user_reporting_history` | Line manager as at a date | `user_id`, `manager_id`, `valid_from`, `valid_to`. **Required** — without it, historical team reports silently rewrite themselves when someone changes manager. |
| `teams` | Service lines | `name`, `head_user_id`, `default_review_policy`, `members_can_create_tasks` |
| `user_capacity` | Standard hours | `user_id`, `hours_per_day`, `valid_from` |
| `leave` | Approved absence | `user_id`, `from_date`, `to_date`, `type`, `status` |
| `working_calendar` | Firm holidays | `date`, `is_working_day`, `label` |
| `clients` | Client master | `name`, `code`, `relationship_partner_id`, `status`, `aliases[]`, `is_internal` |
| `engagements` | Unit of work | `client_id`, `name`, `service_line_team_id`, `fy`, `partner_id`, `manager_id`, `budget_minutes`, `default_review_policy`, `default_billable`, `status`, `start_date`, `end_date` |
| `engagement_members` | Who works on what | `engagement_id`, `user_id`, `capacity` (partner/manager/in_charge/member/observer), `valid_from`, `valid_to`. **This table is the backbone of the visibility model.** |
| `tasks` | Work item + subtasks | Fields per §5.1. `parent_task_id` self-FK, depth-1 constraint. Indexes: `(assignee_id, status, due_date)`, `(engagement_id, status)`, `(due_date) WHERE status NOT IN ('done','cancelled')`, GIN on `search_vector`. |
| `task_transitions` | Allowed state machine | Reference data: `from_status`, `to_status`, `min_scope`, `required_fields[]` |
| `categories` | Work type | `name`, `team_id`, `default_estimate_minutes`, `default_review_required` |
| `tags` / `task_tags` | Free-form labels | |
| `task_watchers` | Follow | `task_id`, `user_id`, `auto` (bool), `muted` |
| `time_entries` | The hours ledger | Fields per §6.2. Partial unique index on running timer; exclusion constraint on overlapping timer ranges per user; index `(user_id, work_date)`, `(task_id)`. |
| `timesheet_periods` | Weekly container | `user_id`, `period_start`, `period_end`, `status` (open/submitted/approved/locked), `submitted_at`, `approved_by_id`, `approved_at`, `locked_at`, `unlocked_by_id`, `unlock_reason` |
| `comments` | Discussion | `task_id`, `author_id`, `body_md`, `mentions[]`, `edited_at`, `deleted_at`, `deleted_by_id` |
| `attachments` | Files | `task_id` or `comment_id`, `blob_key`, `filename`, `mime`, `size_bytes`, `uploaded_by_id`, `scan_status` |
| `recurrence_rules` | Templates + schedule | `engagement_id`, template fields, `schedule` (jsonb / RRULE), `due_date_rule`, `generate_lead_days`, `default_assignee_id`, `active`, `paused_until` |
| `recurrence_instances` | Idempotency guard | Unique `(rule_id, period_key)` → `task_id`. Makes a retried job incapable of double-creating. |
| `notifications` | In-app inbox | `user_id`, `type`, `entity_ref`, `payload`, `read_at`, `coalesce_key` |
| `notification_preferences` | Per-user channel matrix | `user_id`, `type`, `in_app`, `email`, `quiet_hours` |
| `saved_views` | Filter presets | `owner_id` (null = firm-shared), `name`, `filters` (jsonb), `scope` |
| `audit_log` | Compliance record | Shape per §7.3. Monthly partitions. App DB role has INSERT/SELECT only. |
| `exports` | Async export jobs | `user_id`, `preset`, `filters`, `row_count`, `blob_key`, `expires_at` |
| `settings` | Firm configuration | Key/value: period length, timer ceiling, file size cap, escalation timings |

## 16.3 Relationship rules worth stating explicitly

- **A task's client is never stored on the task.** It is reached via `engagement → client`. Denormalising it creates two sources of truth the day an engagement is moved.
- **A task's team is never stored on the task either.** It comes from `engagement.service_line_team_id`. The *assignee's* team is a different thing and is deliberately not the task's team — cross-team staffing is normal.
- **Time entries reference the user directly, not through the task's assignee.** Reassignment must not move hours.
- **`engagement_members` carries validity dates**, so "who was on this engagement in March" remains answerable.
- **Nothing is hard-deleted** except tag links and watcher rows. Everything else soft-deletes.
- **No duplication of hours anywhere.** `tasks.actual_minutes` and `engagements.actual_minutes` are caches with a nightly reconciliation job that reports drift rather than silently correcting it — silent correction hides the bug that caused it.

---

# 17. Technology architecture

## 17.1 Recommended stack

| Layer | Choice | Why |
|---|---|---|
| **App** | Next.js 15 (App Router) + TypeScript, React Server Components | One deployable, one language, server-side data access by default — which makes the "never trust the client" permission rule structural rather than aspirational |
| **UI** | Tailwind CSS + shadcn/ui, TanStack Table | Dense professional tables without building a component library |
| **DB** | Azure Database for **PostgreSQL** Flexible Server (Central India) | Partial unique indexes (the timer constraint), exclusion constraints (overlap detection), JSONB (audit values), native full-text search, `tsrange`. Azure SQL is workable but you would hand-roll three of those. |
| **ORM** | Prisma + raw SQL for reports | Type safety for CRUD; reporting SQL stays SQL |
| **Auth** | Auth.js with **Microsoft Entra ID** (OIDC), tenant-restricted | No passwords to store, MFA and conditional access inherited from M365, automatic deprovisioning |
| **Files** | Azure Blob Storage, private container + Defender for Storage | 5-minute user-scoped SAS on download only |
| **Jobs** | **pg-boss** (Postgres-backed queue) | Recurrence, digests, timer watchdog, overdue sweeps — without adding Redis. One less service to run and back up. |
| **Email** | Microsoft Graph `sendMail` from a service mailbox | Deliverability and archiving already solved by M365 |
| **Hosting** | Azure Container Apps (Linux), Central India | Scale-to-few, simple deploys, VNet-capable |
| **CI/CD** | GitHub Actions → ACR → Container Apps; Prisma migrations gated | |
| **Monitoring** | Azure Application Insights + Postgres slow-query log | |
| **Backup** | Azure automated PITR (35 days) + weekly logical dump to a separate storage account, restore-tested quarterly | An untested backup is not a backup |

## 17.2 Deliberate non-choices

- **No microservices.** One app, one database. At this scale a service mesh is pure cost.
- **No Redis.** Postgres handles the queue and sessions.
- **No Elasticsearch.** §13.
- **No WebSockets in V1.** A 60-second poll on the notification badge is indistinguishable to users and removes a whole class of infrastructure. Add SSE in V2 if the review workflow makes it worthwhile.
- **No mobile app.** A responsive web app with a good mobile timer covers the real need (logging time at a client site). A native app is a second codebase for one feature.
- **No custom permission DSL.** Code, tested. Rule engines here become unauditable.

## 17.3 Identity and provisioning

Sign-in is Entra ID, restricted to the firm's tenant. On first sign-in, a user is created in a **pending** state and appears in an Admin approval queue — a tenant guest account should not silently become a user. Admin assigns role, team, grade, and line manager. A nightly Graph sync deactivates users disabled in Entra (the leaver path). Roles live in the app, not in Entra groups — role changes are frequent, and routing them through IT would make the system annoying to run. Revisit if the firm standardises on Entra group governance.

---

# 18. API and page structure

## 18.1 API

REST-shaped route handlers under `/api/v1`, plus Next.js server actions for form mutations. Every handler: authenticate → authorise via the kernel → validate with Zod → execute in a transaction → write audit → return.

```
POST   /auth/callback/entra-id
GET    /me                                  role, scopes, preferences, running timer

GET    /tasks                               ?filters — scoped, paginated, cursor-based
POST   /tasks
GET    /tasks/:key
PATCH  /tasks/:key                          field-level authorisation; If-Match on updated_at
POST   /tasks/:key/transition               { to, reason?, reviewer? }  ← all status change
POST   /tasks/:key/assign                   { assignee_id, reason? }
POST   /tasks/:key/block  |  /unblock
GET    /tasks/:key/activity
POST   /tasks/:key/comments                 |  PATCH/DELETE /comments/:id
POST   /tasks/:key/attachments              → SAS upload URL
GET    /attachments/:id/download            → short-lived SAS, authorised + logged
POST   /tasks/bulk                          bulk reassign / retag / reschedule (V2)

POST   /timers/start                        { task_id }
POST   /timers/stop                         { note? }
GET    /timers/current
POST   /time-entries                        manual
PATCH  /time-entries/:id                    | DELETE (soft)
GET    /timesheets/:user/:period
POST   /timesheets/:period/submit  | /approve  | /reject  | /unlock (Admin)

GET    /engagements  |  /engagements/:id  |  POST  |  PATCH
GET    /clients      |  /clients/:id
GET    /users        |  /users/:id/workload
GET    /teams

GET    /reports/:preset                     ?dimensions&measures&filters&range
POST   /exports                             async → job → download link
GET    /search                              ?q — scoped, grouped

GET    /notifications  |  POST /notifications/:id/read  |  PATCH /me/notification-prefs
GET    /saved-views    |  POST  |  DELETE

GET    /admin/audit-log                     ?filters (Admin)
CRUD   /admin/users, /admin/recurrence-rules, /admin/categories, /admin/calendar, /admin/settings
```

## 18.2 Pages

```
/                        My Work  (default landing)
/timesheet               Weekly grid — submit / status
/tasks                   Master list: filters, saved views, bulk (V2), URL-encoded state
/tasks/:key              Task detail: fields · subtasks · time · activity · comments · attachments
/tasks/new               Quick-create modal, available from anywhere via  N
/review                  My review queue
/team                    Workload board + exceptions   (Manager+)
/team/approvals          Timesheet approvals           (Manager+)
/clients                 Client list → client → engagements
/engagements/:id         Engagement workspace: tasks, team, budget vs actual, calendar, Kanban (V2)
/reports                 Preset picker → report builder → export
/calendar                Deadline calendar             (V2)
/admin/*                 Users · teams · clients · categories · recurrence · calendar · settings · audit log
/me                      Profile, notification preferences, saved views
```

**UX commitments:**

- Quick-create in ≤ 4 fields: title, engagement, assignee, due date. Everything else optional and collapsed. If task creation takes a full-page form with 20 fields, managers will keep using WhatsApp.
- Keyboard: `⌘K` search · `N` new task · `T` start/stop timer · `J/K` navigate list · `E` edit.
- Every list view's state lives in the URL — so "look at this view" is a paste, not a screenshot.
- Status and priority use shape *and* colour, never colour alone (accessibility, and it prints).
- Optimistic updates on status and timer; everything else confirms.
- Responsive down to phone for: My Work, timer, task detail, comments. Reports and the workload board are desktop-first — pretending a 12-column report works on a phone helps nobody.

---

# 19. Scope: V1 / V2 / V3

## V1 — the usable system (target ~12–14 weeks)

The test for V1 inclusion: *without this, does daily use break down?*

**Foundation** — Entra SSO + provisioning · users, grades, teams, line management · clients · engagements + membership · permission kernel + contract tests · audit log

**Work** — tasks with the §5.1 field set · subtasks (1 level) · six-state lifecycle + Blocked flag · configurable review with reject/rework · reassignment · soft delete · activity feed

**Time** — server-side timer with the single-timer constraint and watchdog · manual entry · weekly timesheet grid · submit/approve/lock · capacity, holidays, leave

**Recurrence** — monthly/quarterly/annual rules · statutory due-date rules · nightly generation · seeded compliance templates

**Visibility** — My Work · Manager dashboard · workload view · master task list with full filters · saved views (preloaded) · global search

**Reporting** — the eight presets in §11.2 · Excel + CSV export

**Collaboration** — comments, @mentions, watchers, attachments

**Notifications** — in-app + the short email list + daily digest + preferences

**Explicitly deferred out of V1:** Kanban, calendar view, PDF export, dependencies, bulk edit, custom fields, Teams integration, mobile-specific UI beyond responsive.

## V2 — once the core is in daily use (~8 weeks)

Everything here should be prioritised by *observed* V1 usage, not by this list.

Kanban per engagement (drag-drop, audited like any other transition) · deadline calendar (day/week/month) · report builder UI + PDF export · bulk actions · soft "blocked by task" links · Teams notifications · engagement budgets and burn-down · custom fields per engagement type · checklists and templates for standard engagements *(likely the highest-value V2 item for a CA firm — an audit programme as a reusable task template)* · leave workflow · SSE live updates · saved report subscriptions (weekly email).

## V3 — leverage, once there is a year of data

Capacity forecasting against the statutory calendar · billing/WIP integration with the practice management system (the `is_billable` flag and engagement structure are already in place for this) · AI-assisted estimates from history, and anomaly flags ("this engagement is trending 40% over") · true dependencies and critical path, *if* V2 usage shows the soft blocked-by link is insufficient · Power BI dataset · public API + webhooks · client-facing status portal · document management integration.

## Reasoning behind this ordering

1. **V1 is scoped to the point where the system replaces the current spreadsheets and WhatsApp**, and not one feature beyond. A partial system that runs alongside the old way is worse than either, because data lives in two places.
2. **Time tracking and recurrence are in V1 despite being the most complex parts**, because they are the reason to use the system at all. Shipping tasks-only first would teach staff it is a to-do list, and retrofitting time discipline onto an established habit is much harder than starting with it.
3. **Everything visual (Kanban, calendar, charts) is V2** — high demo value, low daily value. They are what people ask for in requirements meetings and rarely what they use at 4pm on a filing deadline.
4. **Dependencies are V3 or never.** In a CA firm dependencies are almost always sequential steps within one engagement, which subtask ordering handles. Full dependency graphs are enterprise-PM machinery that goes unused; the soft "blocked by" link in V2 will likely prove sufficient, and that is a cheap way to find out.

---

# 20. User journeys

**A. Manager delegates work (target: 25 seconds)**
Press `N` from anywhere → type title → engagement autocompletes to a recent one → assignee picker shows the team **with current load ratio beside each name** *(this is the design detail that changes behaviour — the overload is visible at the moment of delegation, not in a report next week)* → due date → Create. Assignee gets in-app + email; task lands at the top of their To Do.

**B. Executive works and logs time (target: under 20 seconds of overhead per day)**
Opens My Work → sees overdue first → clicks `T` on the top task → status auto-moves to In Progress → works → stops timer at lunch, adds a note. Afternoon: a client call about a different task — starts that timer, confirms the swap prompt. Friday: opens the weekly grid, sees 34 of 37.5 hours, fills the gap from memory in three cells, submits.

**C. Review and rework**
Executive moves the task to In Review; reviewer is pre-filled from the engagement. Manager's review queue shows it with hours logged vs estimate. Manager rejects with a comment → task returns to In Progress, `review_round` = 2, executive notified. Second pass approved → Done. The rework is now in the data without anyone filling in a quality form.

**D. Partner checks a client before a meeting**
`⌘K` "Meridian" → client page → three engagements, one flagged red (statutory due in 6 days, 40% complete, in-charge at load ratio 1.4) → drills to the engagement → sees the two blocked tasks and the reason → messages the manager. Under a minute, no one interrupted.

**E. Month begins**
Overnight, the recurrence job creates the month's GST tasks across 60 clients, assigned per the rules, due dates set from statute. The GST manager opens the workload board, sees two people over 1.25 and one under 0.6, and rebalances by drag. Four tasks carry the `previous_instance_incomplete` flag — these are the ones to worry about.

**F. Someone leaves**
Admin deactivates the user. The system **blocks completion** until an offboarding wizard reassigns 14 open tasks and 3 pending reviews, and stops any running timer. Their time entries and history remain intact and attributed forever; their login is revoked; they disappear from assignee pickers but not from historical reports.

---

# 21. Edge cases the design must handle

**Time**

- Timer left running overnight → suspend and ask, never auto-log (§6.3)
- Two devices, same user → one server-side timer; the second device shows the same running state
- Manual entry overlapping a timer entry → warn on the timesheet, allow with confirmation
- Backdated entry into a locked period → blocked; correct via an `adjustment` in the open period
- Entry against a task that is later cancelled or reassigned → entry stays with the original person and task
- Timezone: store UTC, display IST, but `work_date` is a plain local date. (India has no DST — one genuine simplification.)
- 16h+ in a day → blocks submission pending a note

**Tasks**

- Task completed with zero logged hours → warn; allow with a reason; report on it (usually a data-quality problem, occasionally legitimate)
- Estimate changed mid-flight → `original_estimate` frozen; accuracy always measured against the original
- Parent marked Done with open subtasks → blocked, Manager override with reason
- Circular parent reference → rejected at the DB level
- Statutory due date pushed past its legal ceiling → rejected regardless of role, except by Admin with a reason
- Two people edit the same task simultaneously → optimistic locking via `If-Match: updated_at`, with a diff shown on conflict rather than a silent overwrite
- Task with no engagement → impossible by constraint; the internal pseudo-client covers non-client work

**People and organisation**

- Leaver with open work → forced reassignment wizard (§20F); never delete a user
- Manager change mid-year → historical reports use the reporting line *as at* the record's date, not today's. Store the reporting relationship with validity dates, or every historical team report silently rewrites itself.
- Article on 8 weeks' exam leave → capacity zeroed, tasks flagged for reassignment before leave starts
- A user is both a manager and a member on different engagements → handled by scoped permissions; a single flat role would break here
- Someone reviewing their own work → blocked; `reviewer_id ≠ assignee_id` enforced

**Clients and engagements**

- Client offboarded mid-year → engagement closed, recurrence series ended, open tasks require disposition, history retained
- Engagement year rollover → "roll forward" clones the structure and recurrence rules into the new FY with dates advanced
- Client renamed or merged → rename in place, retain aliases for search

**Data and operations**

- 200 MB attachment → 25 MB per-file cap, allowlisted types, blocked executables, virus scan before the file is downloadable
- Export of 50,000 rows → async job, email link, capped, logged
- Recurrence job fails one night → idempotent generation keyed on `(rule_id, period)`, so the retry cannot double-create
- Someone imports 5,000 historical tasks → an Admin-only import path with dry-run and rollback

---

# 22. Security model

| Area | Control |
|---|---|
| Authentication | Entra ID OIDC, tenant-restricted, MFA and conditional access inherited from M365. No local passwords anywhere in the system. |
| Session | HTTP-only, Secure, SameSite=Lax cookies; 12-hour idle / 7-day absolute; server-side revocation on deactivation |
| Authorisation | Single kernel; scope predicate on every list query; row check on every fetch; **404 not 403** on denial |
| Field-level | Column-level write rules per role (§3.4) enforced server-side, e.g. Members cannot write `due_date` |
| Input | Zod validation on every boundary; parameterised queries via Prisma; no string-built SQL |
| Files | Private blob container; SAS tokens 5-minute, user-bound, download-only; MIME sniffing not trusted; malware scan; every download audited |
| Transport | TLS 1.2+, HSTS, strict CSP, no inline scripts |
| Rate limiting | Per-user and per-IP on auth, search, export |
| Audit | Append-only, DB-enforced, 7-year retention; failed authorisation attempts logged and alerted above a threshold |
| Data residency | Azure Central India; DPDP Act 2023 applies to employee personal data — publish a retention schedule and a purpose statement before go-live, not after |
| Backups | PITR 35 days + weekly logical dump to a separate storage account; **quarterly restore drill** |
| Secrets | Azure Key Vault + managed identity; nothing in environment files in the repo |
| Dependencies | Dependabot + `npm audit` in CI |
| Environments | Separate dev/staging/prod databases; **production data never copied to dev un-anonymised** — this system holds salary-adjacent and client-confidential data |

---

# 23. Risks and tradeoffs

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Adoption fails — staff don't log time** | **Critical** | This is the risk. Sub-20-second time entry, the weekly grid, digest-only nudges, partner-visible compliance report, and a mandate that timesheet submission is a condition of the process — not an optional nicety. Pilot with one team for a month before firm-wide rollout. |
| 2 | **The data is used punitively and quality collapses** | **Critical** | The §12 metrics policy, enforced in the product: no individual estimate-accuracy screens, no leaderboards, no composite scores. Communicate the purpose explicitly at launch. Trust here is a one-time asset — once spent, the numbers stop being true and no feature can fix it. |
| 3 | **Estimates are missing or nominal, so workload is fiction** | High | Make estimate mandatory at assignment; show unestimated counts alongside every load figure; seed estimates on recurring tasks from the previous instance's actuals. |
| 4 | **Scope creep into billing** | High | V1 explicitly does not bill. The `is_billable` flag and the client/engagement structure make V3 integration cheap, but conflating the two now doubles the scope and drags in the finance team's requirements. |
| 5 | **Statutory calendar seeded wrong** | High | This is a professional content task, not a developer task. A manager must own and sign off the templates. A wrong due date on GSTR-3B across 60 clients is a real exposure. |
| 6 | **Single-assignee model meets resistance** | Medium | Explain accountability and workload arithmetic; subtasks and watchers cover almost every "but two of us work on it" case. Hold the line — this is the correct call. |
| 7 | **Migration from existing spreadsheets** | Medium | Import clients, engagements and open tasks only. Do not migrate historical time; run the old records read-only in parallel for one year. |
| 8 | **No internal owner after launch** | Medium | Name an owner before development starts. A firm-internal tool with no owner accretes stale data within two quarters. |
| 9 | **Permission bug exposes another partner's client** | Medium (high impact) | Contract test suite in CI; 404-not-403; scoped search index; external penetration test before go-live. |
| 10 | **Timer inaccuracy erodes trust in all numbers** | Medium | Watchdog suspends rather than logs; every derived figure links to the entries behind it, so anyone can check. |
| 11 | **Build-vs-buy** | — | Worth stating: no off-the-shelf tool combines Indian statutory recurrence, engagement-based visibility, and firm-controlled data at this price. But if the firm's practice management software already has a timesheet module, integrate rather than duplicate — two places to log time means neither gets used. **Confirm this before we start.** |

## Explicit tradeoffs accepted

| Chosen | Rejected | Cost accepted |
|---|---|---|
| Postgres FTS | Elasticsearch | Weaker relevance ranking, no fuzzy scoring beyond trigram — irrelevant at this volume |
| pg-boss | Redis/BullMQ | Lower job throughput; irrelevant for nightly batches |
| Polling | WebSockets | Up to 60s notification latency; removes an infrastructure class |
| Monolith | Microservices | Scales vertically only — fine to several hundred users |
| Single assignee | Multiple | Occasional friction; buys accountability and correct workload maths |
| One-level subtasks | Arbitrary nesting | Very large tasks need an engagement, not deeper trees — which is the right answer anyway |
| Period locking | Per-entry approval | Slightly coarser control; buys reviews that actually happen |
| Roles in app | Entra groups | Manual role admin; buys speed of change |

---

# 24. Traceability — the 15 questions, answered

Verification that every question in the brief is answerable from the model above, and by which query.

| # | Question | Answered by |
|---|---|---|
| 1 | What work exists? | `tasks` filtered by scope; master list + engagement view |
| 2 | Who assigned it? | `assigned_by_id` (current) + activity log (full chain) |
| 3 | Who is responsible? | `assignee_id`; plus `reviewer_id` for accountability on review |
| 4 | When was it assigned? | `assigned_at`, and every prior assignment in the activity log |
| 5 | When is it due? | `due_date` + `due_date_type` + optional internal `target_date` |
| 6 | How much time was estimated? | `original_estimate_minutes` (frozen) and `current_estimate_minutes` |
| 7 | How much time has been spent? | `Σ time_entries.duration_minutes`, cached on `tasks.actual_minutes` |
| 8 | Current status? | `status` + `is_blocked` flag + `review_round` |
| 9 | Is it overdue? | `due_date < today AND status NOT IN (done, cancelled)`, severity by `due_date_type` |
| 10 | What is each employee working on? | Tasks where `assignee_id = user AND status = in_progress`, plus the live timer |
| 11 | Who is overloaded? | `load_ratio` per §10 — committed hours vs available hours, not task count |
| 12 | What has been completed? | `status = done` by `completion_date` range, any dimension |
| 13 | What is getting delayed? | Overdue register + ageing + blocked > N days + `previous_instance_incomplete` |
| 14 | How accurate are our estimates? | Median `actual ÷ original_estimate` by category/team — **and §12.3 is what keeps this answer true over time** |
| 15 | How is the team performing? | On-time completion rate, cycle time, rework rate, load distribution — trended quarterly at team level (§12.1) |

**Note on Q14 and Q15.** These two are the reason §12.3 exists. Both answers are only as honest as the data behind them, and both data sources are destroyed by the same act: attaching individual consequences to the numbers. The model can produce the answers; only firm policy can keep them true.

---

# 25. What I need from you before building

1. **Confirm the model**: Client → Engagement → Task, with engagement-based visibility. Everything else rests on this.
2. **Does the firm's existing practice-management software already record time?** If yes, we integrate rather than duplicate — see Risk 11. This is the one answer that could materially change the plan.
3. **Confirm the metrics policy** (§12.3) — specifically that estimate accuracy and hours logged stay out of individual appraisals. I would like this agreed at partner level before it is built, because the product enforces it.
4. **Name the internal owner** and the pilot team.
5. **Who signs off the statutory calendar templates?**
6. **Confirm the V1 line** in §19 — particularly that Kanban and calendar wait for V2.
7. **Service lines and grades** — confirm the actual list so the seed data is right.

---

**Approval requested.** On approval I will implement in this order, with a working system at the end of each stage rather than a big-bang delivery:

1. Foundation — schema, Entra auth, permission kernel + contract tests, user/team/client/engagement admin
2. Tasks — CRUD, lifecycle, subtasks, activity feed, task detail, master list, filters
3. Time — timer, manual entry, weekly grid, timesheets, locking, capacity
4. Recurrence — rules engine, generation job, statutory templates
5. Visibility — My Work, manager dashboard, workload, saved views, search
6. Reporting and exports
7. Notifications and digests
8. Hardening — pen test, load test, backup drill, UAT with the pilot team
