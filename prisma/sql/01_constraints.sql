-- OnTrack — constraints Prisma cannot express.
-- Run AFTER `prisma migrate dev`. Copy into the generated migration file so it
-- becomes part of the migration history rather than a manual step someone forgets.

-- ═══════════════════════════════════════════════════════════════
-- 1. ONE RUNNING TIMER PER USER
-- ═══════════════════════════════════════════════════════════════
-- Application-level checks race: two clicks 50ms apart both read "no timer"
-- and both insert. A partial unique index cannot be raced. This is the
-- constraint that makes the timer trustworthy.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_running_timer_per_user
  ON time_entries (user_id)
  WHERE ended_at IS NULL
    AND source = 'TIMER'
    AND deleted_at IS NULL;

-- Timer sessions for the same user must not overlap in time.
-- Requires btree_gist for the scalar user_id alongside the range.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS no_overlapping_timer_sessions;

ALTER TABLE time_entries
  ADD CONSTRAINT no_overlapping_timer_sessions
  EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(started_at, ended_at) WITH &&
  )
  WHERE (source = 'TIMER' AND ended_at IS NOT NULL AND deleted_at IS NULL);

-- Sanity guardrails.
ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS duration_non_negative,
  DROP CONSTRAINT IF EXISTS note_required_for_long_entries;

ALTER TABLE time_entries
  ADD CONSTRAINT duration_non_negative CHECK (duration_minutes >= 0),
  -- > 8 hours in a single entry needs an explanation.
  ADD CONSTRAINT note_required_for_long_entries
    CHECK (duration_minutes <= 480 OR note IS NOT NULL);


-- ═══════════════════════════════════════════════════════════════
-- 2. SUBTASK DEPTH CAPPED AT ONE LEVEL
-- ═══════════════════════════════════════════════════════════════
-- A subtask may not itself have subtasks, and a task cannot be its own
-- ancestor. Enforced in the database because a service-layer check is one
-- forgotten code path away from an infinite tree.

CREATE OR REPLACE FUNCTION enforce_subtask_depth()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_task_id = NEW.id THEN
    RAISE EXCEPTION 'A task cannot be its own parent (task %)', NEW.id;
  END IF;

  -- The parent must be a root task.
  IF EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.parent_task_id AND parent_task_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Subtasks are capped at one level: task % is already a subtask',
      NEW.parent_task_id;
  END IF;

  -- This task must not already have children.
  IF EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = NEW.id) THEN
    RAISE EXCEPTION 'Task % has subtasks and cannot itself become a subtask', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subtask_depth ON tasks;
CREATE TRIGGER trg_subtask_depth
  BEFORE INSERT OR UPDATE OF parent_task_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_subtask_depth();


-- ═══════════════════════════════════════════════════════════════
-- 3. TASK INVARIANTS
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS reviewer_is_not_assignee,
  DROP CONSTRAINT IF EXISTS reviewer_present_when_required,
  DROP CONSTRAINT IF EXISTS blocked_needs_reason,
  DROP CONSTRAINT IF EXISTS due_within_statutory_ceiling,
  DROP CONSTRAINT IF EXISTS estimates_non_negative;

ALTER TABLE tasks
  -- Nobody reviews their own work.
  ADD CONSTRAINT reviewer_is_not_assignee
    CHECK (reviewer_id IS NULL OR reviewer_id <> assignee_id),

  -- A task in REVIEW must have somebody to review it.
  ADD CONSTRAINT reviewer_present_when_required
    CHECK (status <> 'REVIEW' OR reviewer_id IS NOT NULL),

  -- "Blocked" with no reason is noise nobody can act on.
  ADD CONSTRAINT blocked_needs_reason
    CHECK (is_blocked = false OR blocked_reason IS NOT NULL),

  -- A statutory deadline is a ceiling, not a suggestion.
  ADD CONSTRAINT due_within_statutory_ceiling
    CHECK (statutory_due_date IS NULL OR due_date <= statutory_due_date),

  ADD CONSTRAINT estimates_non_negative
    CHECK (
      (original_estimate_minutes IS NULL OR original_estimate_minutes >= 0)
      AND (current_estimate_minutes IS NULL OR current_estimate_minutes >= 0)
      AND actual_minutes >= 0
    );


-- ═══════════════════════════════════════════════════════════════
-- 4. HUMAN-READABLE TASK KEYS  (TSK-2026-00001)
-- ═══════════════════════════════════════════════════════════════
-- A per-year sequence. Users quote these in email and on calls; an opaque
-- UUID is useless for that and a bare integer leaks volume.

CREATE TABLE IF NOT EXISTS task_key_counters (
  year  int PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION next_task_key()
RETURNS text AS $$
DECLARE
  y int := EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Kolkata');
  n bigint;
BEGIN
  INSERT INTO task_key_counters (year, value)
       VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE SET value = task_key_counters.value + 1
    RETURNING value INTO n;

  RETURN 'TSK-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════
-- 5. FULL-TEXT SEARCH
-- ═══════════════════════════════════════════════════════════════
-- Postgres FTS over the task and its context. At this firm's scale this is
-- comfortably sufficient; Elasticsearch would add an operational dependency,
-- a sync pipeline, and a second place for the permission model to leak.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION tasks_build_search_vector()
RETURNS TRIGGER AS $$
DECLARE
  client_name     text;
  engagement_name text;
  assignee_name   text;
  tag_names       text;
BEGIN
  SELECT c.name, e.name INTO client_name, engagement_name
    FROM engagements e JOIN clients c ON c.id = e.client_id
   WHERE e.id = NEW.engagement_id;

  SELECT u.name INTO assignee_name FROM users u WHERE u.id = NEW.assignee_id;

  SELECT string_agg(t.name, ' ') INTO tag_names
    FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
   WHERE tt.task_id = NEW.id;

  NEW.search_vector :=
      setweight(to_tsvector('english', coalesce(NEW.display_key, '')), 'A')
    || setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(client_name, '')), 'B')
    || setweight(to_tsvector('english', coalesce(engagement_name, '')), 'B')
    || setweight(to_tsvector('english', coalesce(assignee_name, '')), 'C')
    || setweight(to_tsvector('english', coalesce(tag_names, '')), 'C')
    || setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_search_vector ON tasks;
CREATE TRIGGER trg_tasks_search_vector
  BEFORE INSERT OR UPDATE OF title, description, display_key, engagement_id, assignee_id
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_build_search_vector();

CREATE INDEX IF NOT EXISTS idx_tasks_search ON tasks USING GIN (search_vector);

-- Fuzzy client-name matching ("meridan" → "Meridian").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm ON clients USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm  ON tasks   USING GIN (title gin_trgm_ops);


-- ═══════════════════════════════════════════════════════════════
-- 6. PARTIAL INDEXES FOR THE HOT QUERIES
-- ═══════════════════════════════════════════════════════════════
-- Open tasks are a small fraction of the table after a couple of years.
-- Indexing only those keeps the dashboards fast indefinitely.

CREATE INDEX IF NOT EXISTS idx_tasks_open_by_assignee
  ON tasks (assignee_id, due_date)
  WHERE status IN ('ASSIGNED', 'IN_PROGRESS', 'REVIEW') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_overdue
  ON tasks (due_date)
  WHERE status IN ('ASSIGNED', 'IN_PROGRESS', 'REVIEW') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_blocked
  ON tasks (blocked_since)
  WHERE is_blocked = true AND deleted_at IS NULL;
