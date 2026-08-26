# OnTrack — Genericisation Audit

**Question asked:** is OnTrack a CA-firm application, or a task engine currently configured for a CA firm?
**Date:** 26 August 2026 · **Audited at:** `de1aced` · **Completed at:** `eb570a8`

---

## STATUS — five of six done

| Step | Commit | Outcome |
|---|---|---|
| **G1** Organization entity | `cfea0fa` | Name, logo, timezone, date format, working week, key prefix, search language, terminology. Users/teams/clients scoped to it. |
| **G2** Constants → configuration | `50619ce` | `next_task_key()` and the search trigger read the organisation. The hardcoded `Asia/Kolkata` was a real bug: task-key years were computed in IST wherever the organisation actually is. |
| **G3** Capability-based permissions | `a9dc976` | Roles are rows. **No role name is compared anywhere in the kernel.** |
| **G5** Generic vocabulary | `be5ef0a` | `external_deadline`, `EXTERNAL_FIXED`/`COMMITTED`, grade as free text. |
| **G6** UI terminology | `eb570a8` | Nav, badges and form labels read from configuration. Two runnable example configurations. |
| **G4** Configurable statuses | — | **Deferred.** Design settled (§6); migration stays mechanical while all status logic funnels through `transitions.ts`. |

**Verified by demonstration, not assertion:**

- `JOB-2026-00027` then `TSK-2026-00028` — same function, prefix changed in the database
- Nav reading **Customers**, badges reading **SLA**, after one `UPDATE` to `terminology`
- 156 tests green throughout

**One security regression caught during the work.** `view.all_tasks` was granted to Partner on the assumption it meant "may open the All Tasks screen". It actually bypasses `visibleTaskFilter` entirely, so every partner could read every other partner's client portfolio — a confidentiality breach with no error, no crash and no visible symptom. Three Stage-3 visibility tests caught it in under a second. Split into `view.all_tasks` (administrators, unrestricted) and `view.portfolio` (screen gate, still relationship-filtered), with a migration guard that refuses to complete if any non-administrator role holds the bypass.

---

---

## 0. Headline

**Most of what we have built is already generic.** That is not luck — the design decisions that mattered were made for correctness reasons that happen to be industry-neutral.

The CA-specific surface is real but narrower than it looks: it is concentrated in **names, enums and three hardcoded constants**, not in the engine.

| | Lines of substance | Verdict |
|---|---|---|
| Permission kernel (visibility, write access) | ~330 | **Generic.** Relationship-based, not hierarchy-based. |
| Timer + database constraints | ~200 | **Generic.** |
| Activity log | ~110 | **Generic.** |
| Task service (CRUD, transitions, optimistic locking) | ~560 | **Generic**, minus enum references |
| Error mapping / HTTP layer | ~230 | **Generic.** |
| Schema (19 tables) | — | **Generic shape**, CA-specific *names* on 2 tables and 4 enums |
| UI | ~700 | Labels only |

The single most valuable thing we built — visibility as a **union of relationships** (assignee, contributor, reviewer, creator, work-area member, line manager) rather than an org-chart walk — is exactly what §7 of your direction asks for. It was built that way because a CA firm's matrix staffing broke the tree model; it turns out every organisation with cross-functional work has the same problem.

---

## 1. What is currently CA-specific

### 1a. Genuine defects — wrong for *any* organisation, including this one

| # | Item | Where | Why it is a defect |
|---|---|---|---|
| D1 | **`Asia/Kolkata` hardcoded** | `next_task_key()` in the initial migration | Task keys roll over at midnight IST regardless of where the organisation is. Not configuration — a bug wearing configuration's clothes. |
| D2 | **`TSK-` prefix hardcoded** | same function | Every organisation gets `TSK-`. |
| D3 | **`to_tsvector('english', …)`** | search trigger | Stemming is English-only. Wrong for a Gujarati or Hindi corpus even at this firm. |

These three are cheap to fix and should be fixed regardless of the product direction.

### 1b. Names that carry CA assumptions into the code

| # | Item | Where | Blast radius |
|---|---|---|---|
| N1 | `Client`, `Engagement` models | schema + ~18 files | **Large** — the central decision, see §5 |
| N2 | `Role` enum contains `PARTNER` | schema, permission kernel | Medium |
| N3 | `Grade` enum: `ARTICLE`, `PARTNER`, `ASSISTANT_MANAGER` | schema, seed, sign-in page | Small — used for display and defaults only |
| N4 | `EngagementCapacity`: `IN_CHARGE` | schema, service, fixtures | Small |
| N5 | `DueDateType`: `STATUTORY`, `CLIENT_COMMITTED` | schema, UI badge, recurrence default | Small |
| N6 | `statutoryDueDate` column | schema, CHECK constraint, service, UI | Small |
| N7 | UI strings: "Client", "Engagement", "Stat" | 4 components | Small |

### 1c. Structural gaps

| # | Item | Consequence |
|---|---|---|
| S1 | **No `Organization` entity at all** | Nowhere to put terminology, timezone, date format, working week, branding. Every setting is either hardcoded or in a global `settings` table with no owner. |
| S2 | **Roles are an enum, not a capability set** | `canWriteField` switches on `Role.MANAGER`. Another organisation cannot define "Team Lead" without a code change. Directly contradicts §5 of the direction. |
| S3 | **`TaskStatus` is a fixed enum** | "Open → In Progress → QA → Done" is impossible without a migration. |

---

## 2. What is already generic and should not be touched

Listing this explicitly because the temptation in a genericisation pass is to rewrite things that are already right.

- **Visibility model.** Union of relationships. Already satisfies §7.
- **Owner + contributors.** No professional-services assumption.
- **Optimistic locking, activity log, transaction discipline.**
- **Timer**: one running timer per user, no overlapping sessions, suspend-don't-guess on a forgotten timer. Universal.
- **404-not-403**, error mapping, BigInt serialisation.
- **Subtask depth cap, leaf-only workload arithmetic.** The double-counting bug we fixed in Stage 7 is industry-neutral.
- **Task core fields**: title, description, assignee, dates, estimate, actual, priority, tags, blocked flag.
- **Filter engine** in `listTasks`.
- **Time entries**: `User → TimeEntry → Task`, with `work_date` as a calendar day. Already exactly §13.

---

## 3. What must change NOW

The test applied: **is this cheap now and expensive later?** With ~26 seeded tasks and no production data, the answer is driven almost entirely by how many *future* stages would build on the assumption.

| # | Change | Why now |
|---|---|---|
| C1 | Fix D1, D2, D3 (timezone, key prefix, search language) | Defects. Ten minutes. |
| C2 | **Add `Organization`** with settings: name, timezone, date format, working week, terminology | Everything else needs somewhere to live. One migration, three FKs — not nineteen. |
| C3 | **Capability-based permissions**: roles become named sets of capabilities | Stages 8–15 add role checks at every screen. Every stage delayed multiplies the call sites to fix. This is the change with the steepest cost curve. |
| C4 | `Grade` enum → org-configured value | Trivial now (it is display-only), annoying once reports group by it. |
| C5 | `statutoryDueDate` → `externalDeadline`; `DueDateType` values become org-configured labels over **two semantics**: *movable* and *fixed* | One column, one constraint, one badge. §10 satisfied without a deadline-type engine. |
| C6 | Terminology resolution for UI labels | Needed before Stages 8–15 write ~20 more hardcoded "Client" strings. |
| C7 | **The hierarchy decision** — §5 below | The single largest item. Needs your call. |

## 4. What should be deferred to V2 — and why

Recorded here so these are decisions, not oversights.

| Deferred | Reasoning |
|---|---|
| **Custom fields** | Your §11 says so explicitly, and I agree. A controlled custom-field mechanism (definition table + JSONB values + typed validation) is roughly a week's work and touches every screen. The core task system must be finished first. |
| **Fully configurable statuses** | See §6 — I want to argue for a *constrained* version rather than free-form, and the migration is mechanical whenever we do it. |
| **Multi-tenant row isolation** | Adding `organizationId` to all 19 tables and enforcing it in every query is real work with real risk. Not needed while there is one organisation, and the `Organization` entity from C2 means the data model is not lying in the meantime. |
| **Multiple identity providers** | Auth.js already accepts a provider array, and the Entra provider is added conditionally from env vars. Adding a second provider later is additive. §14 satisfied as-is. |
| **Working calendar, capacity model, leave** | Cut in the original scope lock. Unchanged. |
| **Configurable recurrence semantics** | The rule already expresses *period → due date*, which is generic. Only the `STATUTORY` default is CA-flavoured, handled by C5. |

---

## 5. The decision I need from you: work hierarchy

This is C7, and it is the largest item. Three options.

### Option A — Rename to neutral fixed levels

`Client` → **`Account`**, `Engagement` → **`Project`**. Two fixed levels above Task, forever.

- ✅ Mechanical, low-risk, keeps full type safety and current query shapes
- ✅ ~3 hours of guided work
- ❌ An organisation wanting *only* `Project → Task` has a vestigial Account level
- ❌ An organisation wanting three levels cannot have one

### Option B — Polymorphic work container *(my recommendation)*

One self-referencing table replaces both:

```
WorkContainer  id · parentId · typeId · name · ownerId · status
ContainerType  id · orgId · level · singularLabel · pluralLabel
Task           containerId · rootContainerId (denormalised)
```

Configured per organisation:

| Organisation | ContainerTypes | Result |
|---|---|---|
| CA firm | level 1 "Client", level 2 "Engagement" | Client → Engagement → Task |
| Software company | level 1 "Customer", level 2 "Project" | Customer → Project → Task |
| Internal team | level 1 "Project" only | Project → Task |
| Manufacturer | level 1 "Department", level 2 "Work Order" | Department → Work Order → Task |

- ✅ Depth becomes configuration; adding or removing a level is a settings change
- ✅ Exactly meets the §19 test
- ✅ `rootContainerId` denormalised keeps "all tasks for client X" a single indexed lookup
- ❌ Loses distinct typed columns (`Client.relationshipPartnerId` vs `Engagement.partnerId` become container attributes)
- ❌ Slightly more abstract to read
- ❌ ~6–8 hours of guided work, touching schema, service, kernel, fixtures, 156 tests, and the UI

This is what Jira, Asana and Monday all converged on, for the same reason.

### Option C — Defer entirely

Keep `Client`/`Engagement`, add configurable labels only.

- ✅ Zero risk, zero delay
- ❌ Stages 8–15 write another ~2,000 lines against `engagement`
- ❌ The migration then costs 3–4× more and carries data

### My recommendation

**Option B**, and now rather than later — but with a caveat I want to be honest about: it is the one change in this list that could destabilise a currently-green 156-test suite. If you prefer to protect that stability and accept a fixed two-level hierarchy for the first release, **Option A is a defensible answer**, and it still removes the CA vocabulary from the code.

**Option C I would argue against.** The whole point of doing this now is that later is more expensive, and deferring the largest item while doing the small ones captures the least value.

---

## 6. A design argument: statuses should be constrained, not free-form

Your §8 asks for organisation-configurable statuses. I agree, with one important qualification.

**Free-form status lists break every metric in the system.** If an organisation can invent "Waiting", "Parked" and "Nearly done", then "overdue", "completion rate", "cycle time" and "open workload" have no definition — the engine cannot know whether "Parked" means the work is live or finished.

The answer every mature system converged on: **each status has a name the organisation chooses and a *category* the engine understands.**

```
Status   id · orgId · label · category · order · isDefault
Category (engine-owned) : NOT_STARTED · ACTIVE · PENDING_REVIEW · DONE · CANCELLED
```

| Organisation | Their labels | Engine sees |
|---|---|---|
| CA firm | Assigned · In Progress · Review · Completed | NOT_STARTED · ACTIVE · PENDING_REVIEW · DONE |
| Software | Open · In Progress · QA · Done | NOT_STARTED · ACTIVE · PENDING_REVIEW · DONE |
| Ops team | Backlog · Assigned · In Progress · Completed | NOT_STARTED · NOT_STARTED · ACTIVE · DONE |

Reports, overdue logic and workload all key off the **category**. Users only ever see the **label**.

**Recommendation:** V2, because the migration is mechanical *provided* all status logic stays funnelled through `transitions.ts` — which it currently is, and which I will keep enforcing. Documented here so it is a deliberate deferral.

---

## 7. Proposed sequence

Assuming Option B, and keeping to one checkpoint at a time:

| Step | Work | Risk |
|---|---|---|
| G1 | Fix the three hardcoded constants (D1–D3) | Very low |
| G2 | Add `Organization` + settings + terminology; seed the CA firm as configuration | Low |
| G3 | Capabilities: `capabilities` + `roles` + `role_capabilities`; kernel reads capabilities; seed the four current roles | **Medium** — the kernel is the crown jewel |
| G4 | `Grade` → org value; `statutoryDueDate` → `externalDeadline`; deadline types configurable | Low |
| G5 | Hierarchy migration (Option B) | **High** — biggest single change |
| G6 | Terminology in the UI; remove hardcoded labels | Low |
| G7 | Full suite green; commit; resume Stage 8 | — |

**Every step ends with 156+ tests passing.** If any step cannot, we stop and reassess rather than pressing on.

---

## 8. The §19 test, after this work

| Organisation | Configuration only? |
|---|---|
| CA firm — Client → Engagement → Task | ✅ |
| Software company — Customer → Project → Task | ✅ |
| Internal team — Project → Task | ✅ |
| Manufacturer — Department → Work Order → Task | ✅ |
| Any of the above with different role names | ✅ after G3 |
| Any of the above with different status names | ❌ until the V2 status work |
| Any of the above with industry-specific fields | ❌ until V2 custom fields |

Two gaps, both deliberate, both documented.
