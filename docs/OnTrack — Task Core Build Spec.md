# OnTrack — Task Management Core
## Locked Build Spec (Phase 1)

**Supersedes** the full product specification for implementation purposes. The earlier document remains the long-range reference; **this document is the scope contract for what gets built now.** Anything not in this document is not being built.

**Decisions confirmed:** assignee required (no Backlog) · review per-engagement default with per-task override · in-app notifications + email on assignment only · one accountable owner plus contributors (see §3).

---

## 1. Scope lock — what is IN

| Area | In scope |
|---|---|
| **Hierarchy** | Client → Engagement → Task → Subtask (one level) |
| **Task** | Full field set per §2, single assignee, contributors, tags, attachments, comments, subtasks |
| **Status** | Assigned → In Progress → Review → Completed, plus Cancelled; Reopened as a transition; **Blocked as a flag** |
| **Assignment** | Create, assign, reassign, change deadline, change priority — permission-gated |
| **Visibility** | Relationship-based authorisation (§4), never ID-guessable |
| **Time** | Server-side timer with sessions + manual entry + edit with audit |
| **Activity** | Append-only per-task history with old/new values |
| **Views** | My Tasks · Assigned by Me · Team Tasks · All Tasks |
| **Filters** | Client, engagement, assignee, assignor, status, priority, blocked, due date, overdue, tags + quick filters |
| **Search** | PostgreSQL full-text — no separate search infrastructure |
| **Dashboards** | Employee + Senior, actionable rows over charts |
| **Reports** | The ten listed reports, filterable, CSV + Excel export |
| **Recurrence** | Rule → generated tasks. Monthly / quarterly / annual + statutory due-date rule |
| **Notifications** | In-app for five event types; email on assignment only |

## 2. Scope lock — what is OUT (cut from the earlier spec)

Each of these was in the full specification and is **removed from this phase**:

| Cut | Why it's safe to cut |
|---|---|
| **Timesheet periods, submission, approval, locking** | Billing-adjacent practice management. Time entries stay editable by their owner with a full audit trail; that is sufficient for planning and reporting, which is all this phase claims to do. |
| **Capacity model, leave, working calendar, load ratio** | "Who is overloaded" becomes *estimated remaining hours per person*, a number the manager interprets — rather than a computed band that needs a leave feed to be correct. Removes three tables and an HR integration. |
| **Billable flags, budgets, engagement financials** | Billing is out of scope. Not stored, not modelled. |
| **Reporting-line history table** | Team reports use the current reporting line. Known limitation: historical team reports shift if someone changes manager. Accepted for this phase. |
| **Separate firm-wide audit log** | One `activity_log` table covers task events plus attachment downloads and exports. Two tables were justified by 7-year compliance retention, which this phase doesn't claim. |
| **Watchers** | Notifications go to the people with a defined relationship to the task (assignee, assigner, reviewer, mentioned). No opt-in follow list. |
| **Observer engagement capacity, scope enum** | Visibility is the six explicit predicates in §4, coded directly. No abstract scope machinery. |
| **Kanban, calendar view, dependencies, PDF export, bulk edit, custom fields, Teams integration, SSE** | Explicitly out per the scope lock. |
| **Estimate-accuracy scoring per person** | Not built, by design. §6. |

## 3. Owner + contributors — answering the open question

**Yes, the model supports one owner plus contributors, and that is what I've built.**

- `task.assignee_id` — the **single accountable owner**. Unchanged. One person answers for the task.
- `task_contributors` — anyone else who legitimately works on it. Added by the assignee or a manager.

| | Assignee | Contributor | Reviewer |
|---|---|---|---|
| Log time on the task | ✓ | ✓ | ✓ *(auto-contributor)* |
| Comment, attach | ✓ | ✓ | ✓ |
| Change status | ✓ | — | ✓ *(approve/reject only)* |
| Change deadline, priority, assignee | — *(manager only)* | — | — |
| Appears in "My Tasks" | ✓ | ✓ *(flagged "contributing")* | ✓ *(in Awaiting My Review)* |

This preserves accountability — status and dates still have exactly one owner — while capturing the real effort, including review time, which would otherwise be invisible.

**One honest caveat:** the task's *remaining estimated hours* are attributed wholly to the assignee for workload purposes, even when contributors will do some of it. Splitting the estimate across contributors is a planning feature that belongs in a later phase; over-splitting it now would add a field nobody maintains. Where work is genuinely shared, a subtask assigned to the other person is the accurate model, and the UI will suggest that when a third contributor is added.

---

## 4. Visibility model

A user can see a task if **any** of these is true:

1. They are the **assignee**
2. They are a **contributor**
3. They are the **reviewer**
4. They **created** it or **assigned** it
5. They are an **active member of its engagement**
6. They **line-manage** the assignee, transitively
7. They are an **Admin**, or the **Partner/Manager on the engagement**

Implemented as one function, `visibleTaskFilter(user)`, returning a Prisma `where` clause. Every list query composes it. Every fetch-by-id runs the same check after load and returns **404, not 403**, on failure — a 403 confirms the record exists.

No authorisation logic lives in React components. UI hiding is cosmetic; every mutation re-checks server-side. A contract test asserts, for a fixture organisation, the exact row set each role sees on every list endpoint.

## 5. Status model

```
  ASSIGNED ──► IN PROGRESS ──► REVIEW ──► COMPLETED
                   ▲   │          │           │
                   │   └──────────┘ reject    │
                   └──────────────────────────┘ reopen
                              
  * ──► CANCELLED  (manager+, reason required)

  ⚑ blocked flag — orthogonal, valid on Assigned / In Progress / Review
```

- **Review is skipped** when `review_required` is false — In Progress goes straight to Completed.
- **Reopened is a transition, not a status.** Completed → In Progress, reason required, `reopen_count` incremented. The task then shows a "Reopened" badge and is filterable as such. Making it a status would mean a reopened task sits in a state that isn't a real workflow position, and every report would need to special-case it — the same reasoning that makes Blocked a flag.
- Transitions are validated server-side against a fixed table. Nothing else is permitted.

## 6. Time tracking

- `time_entries` is the ledger; `task.actual_minutes` is a cache written in the same transaction.
- **Server owns the clock.** Timer stores `started_at` server-side; the browser only renders elapsed. Survives closed tabs, crashes, second devices.
- **One running timer per user**, enforced by a partial unique index — application checks race, the index cannot. Starting a second timer prompts to stop the first; both happen in one transaction.
- **Forgotten timers are suspended, not auto-logged.** A timer past 10 hours is flagged; the user is asked how long they actually worked. Writing 14 silent hours poisons the data and destroys trust in every number in the system.
- **Manual entry is first-class**, including a weekly grid. Staff work at client sites and on calls; timer-only produces *less* accurate data, just without a UI for it.
- `work_date` is a plain local date, separate from `created_at`, so Friday's work logged on Monday is dated Friday.
- Edits and deletes are soft and audited. Guardrails: >8h single entry requires a note, >16h/day blocked, future dates rejected.
- `original_estimate_minutes` freezes at the first time entry so the Estimated-vs-Actual report compares like with like. **This is a planning input, not a person-level score** — there is no screen anywhere that ranks people by estimate accuracy or hours logged, and none will be added in this phase.

## 7. Activity history

One append-only table. The application's database role has `INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`.

`actor · at · task_id · action · field · old_value · new_value · reason`

Tracked: created · assigned · reassigned · status changed · priority changed · deadline changed · blocked/unblocked · contributor added/removed · comment added/edited/deleted · attachment added/removed/downloaded · timer started/stopped · time edited/deleted · submitted for review · approved · rejected · completed · reopened · cancelled · exported.

`reason` is mandatory for: deadline change, reopen, cancel, rejecting a review, editing someone else's time.

Views are **not** logged — enormous volume, negligible value. Attachment downloads and report exports are, because that is where data leaves the system.

## 8. Notifications

**In-app:** assigned to me · review requested of me · my work rejected · my deadline changed by someone else · mentioned in a comment · added as a contributor.
**Email (Microsoft Graph, service mailbox):** task assigned to me. Nothing else.

Never notify a user of their own action. Events on one task within 15 minutes coalesce into one notification.

## 9. Data model

**Tables:** `users` · `teams` · `clients` · `engagements` · `engagement_members` · `tasks` · `task_contributors` · `tags` · `task_tags` · `comments` · `attachments` · `time_entries` · `activity_log` · `notifications` · `recurrence_rules` · `recurrence_instances` · `saved_views` · `settings`

Eighteen tables, down from twenty-eight.

**Rules:**
- A task's client is reached via `engagement → client`, never stored on the task.
- Time entries reference the user directly — reassignment never moves hours.
- Subtasks are rows in `tasks` with `parent_task_id`, capped at one level. Workload sums leaf tasks only, or hours are double-counted.
- A parent cannot be Completed while subtasks are open (manager override with reason). Parent status is never auto-set from children.
- Nothing is hard-deleted except tag links and contributor rows.

## 10. Build order

Each stage ends with something that runs.

1. **Foundation** — schema, migrations, Entra auth, permission kernel + contract tests, seed data, admin CRUD for users/teams/clients/engagements
2. **Task core** — CRUD, status machine, subtasks, contributors, activity log, task detail page
3. **Views** — My Tasks, Assigned by Me, Team Tasks, All Tasks, filters, quick filters, search
4. **Time** — timer, manual entry, weekly grid, estimate vs actual
5. **Collaboration** — comments, mentions, attachments, notifications
6. **Dashboards** — employee and senior
7. **Reports** — the ten reports, filters, CSV/Excel export
8. **Recurrence** — rules, generation job, statutory templates
9. **Hardening** — permission tests, load test, UAT

## 11. Stack

Next.js 15 + TypeScript · PostgreSQL + Prisma · Auth.js with Microsoft Entra ID · Azure Blob Storage for attachments · pg-boss for the recurrence and timer-watchdog jobs · Tailwind + shadcn/ui · Azure Container Apps.

No Redis, no Elasticsearch, no microservices, no WebSockets — per the scope lock and because none is justified at this scale.

---

## 12. Requirements I am flagging as additions, per your instruction

Three things in the build are not literally in your scope-lock list. Each is here because the listed requirements do not work without it.

| Addition | Requirement it serves | Why it belongs in the Task Core |
|---|---|---|
| **In-app notifications + assignment email** | "Authorized users should be able to assign tasks" | Assigning work to someone who never learns of it is not assignment. This is the minimum that makes the assignment requirement real. Five in-app event types, one email. |
| **Timer watchdog job** | "Start Timer → work → Stop Timer" | People forget to stop timers — reliably, weekly. Without the watchdog, "Actual: 3h 20m" becomes "Actual: 14h 02m" and the Estimated-vs-Actual report you asked for is worthless. It is one nightly job. |
| **`task_contributors` table** | Your own question on the time-tracking answer | Captures real effort — including review time — without breaking the single-assignee rule. §3. |

Nothing else beyond the scope lock is being built.
