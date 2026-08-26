-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'PARTNER', 'MANAGER', 'MEMBER');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('PARTNER', 'DIRECTOR', 'MANAGER', 'ASSISTANT_MANAGER', 'SENIOR', 'EXECUTIVE', 'ARTICLE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "EngagementCapacity" AS ENUM ('PARTNER', 'MANAGER', 'IN_CHARGE', 'MEMBER');

-- CreateEnum
CREATE TYPE "EngagementStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('CRITICAL', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "DueDateType" AS ENUM ('STATUTORY', 'CLIENT_COMMITTED', 'INTERNAL');

-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('TIMER', 'MANUAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('TASK_CREATED', 'TASK_ASSIGNED', 'TASK_REASSIGNED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'DUE_DATE_CHANGED', 'ESTIMATE_CHANGED', 'BLOCKED', 'UNBLOCKED', 'CONTRIBUTOR_ADDED', 'CONTRIBUTOR_REMOVED', 'COMMENT_ADDED', 'COMMENT_EDITED', 'COMMENT_DELETED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'ATTACHMENT_DOWNLOADED', 'TIMER_STARTED', 'TIMER_STOPPED', 'TIMER_SUSPENDED', 'TIME_LOGGED', 'TIME_EDITED', 'TIME_DELETED', 'SUBMITTED_FOR_REVIEW', 'REVIEW_APPROVED', 'REVIEW_REJECTED', 'TASK_COMPLETED', 'TASK_REOPENED', 'TASK_CANCELLED', 'REPORT_EXPORTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ASSIGNED_TO_ME', 'REVIEW_REQUESTED', 'REVIEW_REJECTED', 'DUE_DATE_CHANGED', 'MENTIONED', 'ADDED_AS_CONTRIBUTOR');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "entra_object_id" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "grade" "Grade" NOT NULL DEFAULT 'EXECUTIVE',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "team_id" BIGINT,
    "reports_to_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deactivated_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "head_user_id" BIGINT,
    "members_can_create_tasks" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "relationship_partner_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagements" (
    "id" BIGSERIAL NOT NULL,
    "client_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "fy" TEXT,
    "status" "EngagementStatus" NOT NULL DEFAULT 'ACTIVE',
    "team_id" BIGINT,
    "partner_id" BIGINT,
    "manager_id" BIGINT,
    "default_review_required" BOOLEAN NOT NULL DEFAULT true,
    "start_date" DATE,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_members" (
    "id" BIGSERIAL NOT NULL,
    "engagement_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "capacity" "EngagementCapacity" NOT NULL DEFAULT 'MEMBER',
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMPTZ(3),

    CONSTRAINT "engagement_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" BIGSERIAL NOT NULL,
    "display_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "engagement_id" BIGINT NOT NULL,
    "parent_task_id" BIGINT,
    "created_by_id" BIGINT NOT NULL,
    "assigned_by_id" BIGINT,
    "assignee_id" BIGINT NOT NULL,
    "review_required" BOOLEAN NOT NULL DEFAULT true,
    "reviewer_id" BIGINT,
    "status" "TaskStatus" NOT NULL DEFAULT 'ASSIGNED',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "blocked_reason" TEXT,
    "blocked_since" TIMESTAMPTZ(3),
    "expected_unblock_date" DATE,
    "due_date" DATE NOT NULL,
    "due_date_type" "DueDateType" NOT NULL DEFAULT 'INTERNAL',
    "statutory_due_date" DATE,
    "original_estimate_minutes" INTEGER,
    "current_estimate_minutes" INTEGER,
    "actual_minutes" INTEGER NOT NULL DEFAULT 0,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "review_round" INTEGER NOT NULL DEFAULT 1,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "recurrence_rule_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_contributors" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "added_by_id" BIGINT NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_tags" (
    "task_id" BIGINT NOT NULL,
    "tag_id" BIGINT NOT NULL,

    CONSTRAINT "task_tags_pkey" PRIMARY KEY ("task_id","tag_id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "work_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_minutes" INTEGER NOT NULL DEFAULT 0,
    "source" "TimeEntrySource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "edited_by_id" BIGINT,
    "edited_at" TIMESTAMPTZ(3),
    "edit_reason" TEXT,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "delete_reason" TEXT,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "author_id" BIGINT NOT NULL,
    "body_md" TEXT NOT NULL,
    "mentions" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" BIGINT,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT,
    "comment_id" BIGINT,
    "blob_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "scan_status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploaded_by_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT,
    "actor_id" BIGINT NOT NULL,
    "action" "ActivityAction" NOT NULL,
    "field" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT,
    "request_id" TEXT,
    "ip" TEXT,
    "acted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "task_id" BIGINT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "coalesce_key" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "email_sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_rules" (
    "id" BIGSERIAL NOT NULL,
    "engagement_id" BIGINT NOT NULL,
    "title_pattern" TEXT NOT NULL,
    "description" TEXT,
    "default_assignee_id" BIGINT,
    "estimate_minutes" INTEGER,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "review_required" BOOLEAN,
    "due_date_type" "DueDateType" NOT NULL DEFAULT 'STATUTORY',
    "frequency" "RecurrenceFrequency" NOT NULL,
    "months_of_year" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "due_day_of_month" INTEGER NOT NULL,
    "due_month_offset" INTEGER NOT NULL DEFAULT 1,
    "generate_lead_days" INTEGER NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ends_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_instances" (
    "id" BIGSERIAL NOT NULL,
    "rule_id" BIGINT NOT NULL,
    "period_key" TEXT NOT NULL,
    "task_id" BIGINT,
    "previous_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurrence_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" BIGSERIAL NOT NULL,
    "owner_id" BIGINT,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_entra_object_id_key" ON "users"("entra_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_team_id_idx" ON "users"("status", "team_id");

-- CreateIndex
CREATE INDEX "users_reports_to_id_idx" ON "users"("reports_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_code_key" ON "clients"("code");

-- CreateIndex
CREATE INDEX "clients_is_active_name_idx" ON "clients"("is_active", "name");

-- CreateIndex
CREATE INDEX "engagements_status_client_id_idx" ON "engagements"("status", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagements_client_id_name_fy_key" ON "engagements"("client_id", "name", "fy");

-- CreateIndex
CREATE INDEX "engagement_members_user_id_valid_to_idx" ON "engagement_members"("user_id", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_members_engagement_id_user_id_valid_from_key" ON "engagement_members"("engagement_id", "user_id", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_display_key_key" ON "tasks"("display_key");

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_due_date_idx" ON "tasks"("assignee_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "tasks_engagement_id_status_idx" ON "tasks"("engagement_id", "status");

-- CreateIndex
CREATE INDEX "tasks_due_date_status_idx" ON "tasks"("due_date", "status");

-- CreateIndex
CREATE INDEX "tasks_reviewer_id_status_idx" ON "tasks"("reviewer_id", "status");

-- CreateIndex
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks"("parent_task_id");

-- CreateIndex
CREATE INDEX "tasks_is_blocked_status_idx" ON "tasks"("is_blocked", "status");

-- CreateIndex
CREATE INDEX "task_contributors_user_id_idx" ON "task_contributors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_contributors_task_id_user_id_key" ON "task_contributors"("task_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "task_tags_tag_id_idx" ON "task_tags"("tag_id");

-- CreateIndex
CREATE INDEX "time_entries_user_id_work_date_idx" ON "time_entries"("user_id", "work_date");

-- CreateIndex
CREATE INDEX "time_entries_task_id_deleted_at_idx" ON "time_entries"("task_id", "deleted_at");

-- CreateIndex
CREATE INDEX "comments_task_id_created_at_idx" ON "comments"("task_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_blob_key_key" ON "attachments"("blob_key");

-- CreateIndex
CREATE INDEX "attachments_task_id_idx" ON "attachments"("task_id");

-- CreateIndex
CREATE INDEX "attachments_comment_id_idx" ON "attachments"("comment_id");

-- CreateIndex
CREATE INDEX "activity_log_task_id_acted_at_idx" ON "activity_log"("task_id", "acted_at");

-- CreateIndex
CREATE INDEX "activity_log_actor_id_acted_at_idx" ON "activity_log"("actor_id", "acted_at");

-- CreateIndex
CREATE INDEX "activity_log_action_acted_at_idx" ON "activity_log"("action", "acted_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_coalesce_key_idx" ON "notifications"("coalesce_key");

-- CreateIndex
CREATE INDEX "recurrence_rules_is_active_engagement_id_idx" ON "recurrence_rules"("is_active", "engagement_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_instances_rule_id_period_key_key" ON "recurrence_instances"("rule_id", "period_key");

-- CreateIndex
CREATE INDEX "saved_views_owner_id_idx" ON "saved_views"("owner_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_reports_to_id_fkey" FOREIGN KEY ("reports_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_relationship_partner_id_fkey" FOREIGN KEY ("relationship_partner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_members" ADD CONSTRAINT "engagement_members_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_members" ADD CONSTRAINT "engagement_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrence_rule_id_fkey" FOREIGN KEY ("recurrence_rule_id") REFERENCES "recurrence_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_contributors" ADD CONSTRAINT "task_contributors_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_contributors" ADD CONSTRAINT "task_contributors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_contributors" ADD CONSTRAINT "task_contributors_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_edited_by_id_fkey" FOREIGN KEY ("edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_default_assignee_id_fkey" FOREIGN KEY ("default_assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recurrence_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- #                                                                         #
-- #   HAND-WRITTEN CONSTRAINTS — everything below this line is maintained    #
-- #   by hand and is NOT regenerated by `prisma migrate`.                    #
-- #                                                                         #
-- #   Source of truth: prisma/sql/01_constraints.sql                         #
-- #                                                                         #
-- #   These live INSIDE the migration deliberately. Run separately, a fresh  #
-- #   environment (staging, production, a new laptop) would get the tables   #
-- #   but not the constraints, and nothing would tell you. The single-       #
-- #   running-timer index in particular is the difference between a          #
-- #   trustworthy timer and a race condition.                                #
-- #                                                                         #
-- ###########################################################################

-- ═══════════════════════════════════════════════════════════════
-- 1. EXTENSIONS
-- ═══════════════════════════════════════════════════════════════
-- Both are "trusted" extensions in PostgreSQL 13+, so the database owner can
-- install them without superuser.
--   btree_gist → scalar user_id alongside a range in the exclusion constraint
--   pg_trgm    → fuzzy client-name matching ("meridan" → "Meridian")

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═══════════════════════════════════════════════════════════════
-- 2. ONE RUNNING TIMER PER USER
-- ═══════════════════════════════════════════════════════════════
-- Application-level checks race: two clicks 50ms apart both read "no timer"
-- and both insert. A partial unique index cannot be raced.

CREATE UNIQUE INDEX uniq_running_timer_per_user
  ON time_entries (user_id)
  WHERE ended_at IS NULL
    AND source = 'TIMER'
    AND deleted_at IS NULL;

-- Completed timer sessions for one user must not overlap in time.
ALTER TABLE time_entries
  ADD CONSTRAINT no_overlapping_timer_sessions
  EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(started_at, ended_at) WITH &&
  )
  WHERE (source = 'TIMER' AND ended_at IS NOT NULL AND deleted_at IS NULL);

-- Sanity guardrails on logged time.
ALTER TABLE time_entries
  ADD CONSTRAINT duration_non_negative
    CHECK (duration_minutes >= 0),
  -- More than 8 hours in a single entry needs an explanation.
  ADD CONSTRAINT note_required_for_long_entries
    CHECK (duration_minutes <= 480 OR note IS NOT NULL),
  -- A timer entry must have a start; a finished one must end after it starts.
  ADD CONSTRAINT timer_entries_have_a_start
    CHECK (source <> 'TIMER' OR started_at IS NOT NULL),
  ADD CONSTRAINT timer_ends_after_it_starts
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at);

-- ═══════════════════════════════════════════════════════════════
-- 3. SUBTASK DEPTH CAPPED AT ONE LEVEL
-- ═══════════════════════════════════════════════════════════════
-- Enforced in the database because a service-layer check is one forgotten
-- code path away from an infinite tree.

CREATE OR REPLACE FUNCTION enforce_subtask_depth()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_task_id = NEW.id THEN
    RAISE EXCEPTION 'A task cannot be its own parent (task %)', NEW.id;
  END IF;

  -- The parent must itself be a root task.
  IF EXISTS (
    SELECT 1 FROM tasks
     WHERE id = NEW.parent_task_id AND parent_task_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Subtasks are capped at one level: task % is already a subtask',
      NEW.parent_task_id;
  END IF;

  -- This task must not already have children of its own.
  IF EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = NEW.id) THEN
    RAISE EXCEPTION 'Task % has subtasks and cannot itself become a subtask', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_subtask_depth
  BEFORE INSERT OR UPDATE OF parent_task_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_subtask_depth();

-- ═══════════════════════════════════════════════════════════════
-- 4. TASK INVARIANTS
-- ═══════════════════════════════════════════════════════════════

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
    ),

  -- Cancelling requires saying why.
  ADD CONSTRAINT cancel_needs_reason
    CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════
-- 5. HUMAN-READABLE TASK KEYS  (TSK-2026-00001)
-- ═══════════════════════════════════════════════════════════════
-- Users quote these in email and on calls. A UUID is useless for that, and a
-- bare sequence number leaks how much work the firm does.

CREATE TABLE task_key_counters (
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
-- 6. FULL-TEXT SEARCH
-- ═══════════════════════════════════════════════════════════════
-- Postgres FTS over the task and its context. At this firm's scale this is
-- comfortably sufficient; Elasticsearch would add an operational dependency,
-- a sync pipeline, and a second surface for the permission model to leak.

ALTER TABLE tasks ADD COLUMN search_vector tsvector;

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

-- Fires on ANY update, not a column list, so that a tag change (which touches
-- updated_at, below) also refreshes the vector.
CREATE TRIGGER trg_tasks_search_vector
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_build_search_vector();

-- Tags are written to a join table AFTER the task row exists, so the task's
-- own trigger has already run and cannot see them. Touch the parent task to
-- force a rebuild.
CREATE OR REPLACE FUNCTION task_tags_touch_task()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tasks SET updated_at = now()
   WHERE id = COALESCE(NEW.task_id, OLD.task_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_tags_touch_task
  AFTER INSERT OR DELETE ON task_tags
  FOR EACH ROW EXECUTE FUNCTION task_tags_touch_task();

CREATE INDEX idx_tasks_search ON tasks USING GIN (search_vector);
CREATE INDEX idx_clients_name_trgm ON clients USING GIN (name gin_trgm_ops);
CREATE INDEX idx_tasks_title_trgm  ON tasks   USING GIN (title gin_trgm_ops);

-- ═══════════════════════════════════════════════════════════════
-- 7. PARTIAL INDEXES FOR THE HOT QUERIES
-- ═══════════════════════════════════════════════════════════════
-- Open tasks are a small fraction of the table after a couple of years.
-- Indexing only those keeps the dashboards fast indefinitely.

CREATE INDEX idx_tasks_open_by_assignee
  ON tasks (assignee_id, due_date)
  WHERE status IN ('ASSIGNED', 'IN_PROGRESS', 'REVIEW') AND deleted_at IS NULL;

CREATE INDEX idx_tasks_overdue
  ON tasks (due_date)
  WHERE status IN ('ASSIGNED', 'IN_PROGRESS', 'REVIEW') AND deleted_at IS NULL;

CREATE INDEX idx_tasks_blocked
  ON tasks (blocked_since)
  WHERE is_blocked = true AND deleted_at IS NULL;

CREATE INDEX idx_time_entries_running
  ON time_entries (user_id, started_at)
  WHERE ended_at IS NULL AND deleted_at IS NULL;
