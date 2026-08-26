-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 03_verify.sql
--
-- WHEN TO RUN: after any migration, in any environment (local, staging, prod).
-- RUN AS:      ontrack_owner (or postgres), connected to the ontrack database.
--
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/03_verify.sql
--
-- MOSTLY READ-ONLY. Section 8 is the one exception: it calls next_task_key()
-- twice to prove the generator works, then resets the counter. That writes to
-- and clears `task_key_counters` and nothing else. Safe on an empty database;
-- on a database with live tasks, skip section 8 (resetting the counter would
-- cause duplicate task keys).
--
-- Why a file rather than ad-hoc queries: "the migration said it worked" is not
-- verification. These are the objects the design depends on, and every one of
-- them is invisible in `schema.prisma`.
-- ═══════════════════════════════════════════════════════════════════════════

\echo ''
\echo '=== 1. TABLES (expect 20: 18 models + task_key_counters + _prisma_migrations) ==='
SELECT count(*) AS table_count
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name;

\echo ''
\echo '=== 2. EXTENSIONS (expect btree_gist and pg_trgm) ==='
SELECT extname, extversion
  FROM pg_extension
 WHERE extname IN ('btree_gist', 'pg_trgm')
 ORDER BY extname;

\echo ''
\echo '=== 3. SINGLE-RUNNING-TIMER INDEX (expect exactly 1 row) ==='
-- The most important object in the database. Without it, two clicks 50ms
-- apart can both create a running timer for the same user.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE indexname = 'uniq_running_timer_per_user';

\echo ''
\echo '=== 4. NO-OVERLAPPING-SESSIONS EXCLUSION CONSTRAINT (expect 1 row) ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname = 'no_overlapping_timer_sessions';

\echo ''
\echo '=== 5. CHECK CONSTRAINTS (expect 10 named ones) ==='
SELECT conrelid::regclass AS on_table, conname
  FROM pg_constraint
 WHERE contype = 'c'
   AND connamespace = 'public'::regnamespace
   AND conname IN (
     'duration_non_negative', 'note_required_for_long_entries',
     'timer_entries_have_a_start', 'timer_ends_after_it_starts',
     'reviewer_is_not_assignee', 'reviewer_present_when_required',
     'blocked_needs_reason', 'due_within_statutory_ceiling',
     'estimates_non_negative', 'cancel_needs_reason'
   )
 ORDER BY 1, 2;

\echo ''
\echo '=== 6. TRIGGERS (expect 3: subtask depth, search vector, task tags) ==='
SELECT tgrelid::regclass AS on_table, tgname
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgrelid::regclass::text IN ('tasks', 'task_tags')
 ORDER BY 1, 2;

\echo ''
\echo '=== 7. FUNCTIONS (expect 4) ==='
SELECT proname
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('enforce_subtask_depth', 'next_task_key',
                   'tasks_build_search_vector', 'task_tags_touch_task')
 ORDER BY proname;

\echo ''
\echo '=== 8. TASK KEY GENERATOR (writes, then resets - see header) ==='
SELECT next_task_key() AS first_key, next_task_key() AS second_key;
DELETE FROM task_key_counters;
\echo '(counter reset - real tasks will start at 00001)'

\echo ''
\echo '=== 9. SEARCH VECTOR COLUMN AND GIN INDEXES ==='
SELECT column_name, udt_name
  FROM information_schema.columns
 WHERE table_name = 'tasks' AND column_name = 'search_vector';

SELECT indexname
  FROM pg_indexes
 WHERE indexname IN ('idx_tasks_search', 'idx_tasks_title_trgm', 'idx_clients_name_trgm')
 ORDER BY indexname;

\echo ''
\echo '=== 10. PARTIAL INDEXES FOR HOT QUERIES (expect 4) ==='
SELECT indexname
  FROM pg_indexes
 WHERE indexname IN ('idx_tasks_open_by_assignee', 'idx_tasks_overdue',
                     'idx_tasks_blocked', 'idx_time_entries_running')
 ORDER BY indexname;

\echo ''
\echo '=== 11. TIMESTAMP TYPES (all instants must be timestamptz) ==='
-- A "timestamp without time zone" here means an instant is being stored with
-- no zone, which reads back 5.5 hours wrong to anything outside the app.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND data_type = 'timestamp without time zone'
 ORDER BY table_name, column_name;
\echo '(expect ZERO rows above)'

SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('tasks', 'time_entries')
   AND data_type = 'date'
 ORDER BY table_name, column_name;
\echo '(expect due_date, expected_unblock_date, statutory_due_date, work_date)'

\echo ''
\echo '=== VERIFICATION COMPLETE ==='
