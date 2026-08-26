-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 04_timer_tests.sql
--
-- Proves the timer safety rules by demonstration, not assertion.
--
-- RUN AS:  ontrack_owner, connected to the ontrack database.
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/04_timer_tests.sql
--
-- SAFE TO RUN AT ANY TIME. Everything happens inside one transaction that ends
-- in ROLLBACK. No fixture, no timer and no task-key increment survives. Run it
-- against production if you want to; it will leave nothing behind.
--
-- Some statements below are EXPECTED TO FAIL. Each is preceded by a
-- "MUST FAIL" banner. An ERROR after one of those banners is the test PASSING.
-- ON_ERROR_STOP is off so the script continues past them; SAVEPOINTs restore
-- the transaction to a usable state afterwards.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off
\timing off

BEGIN;

\echo ''
\echo '################ SETTING UP FIXTURES ################'

INSERT INTO users (email, name, role, grade, status, updated_at) VALUES
  ('alice.timer.test@example.invalid', 'Alice Test', 'MEMBER', 'SENIOR', 'ACTIVE', now()),
  ('bob.timer.test@example.invalid',   'Bob Test',   'MEMBER', 'SENIOR', 'ACTIVE', now());

INSERT INTO clients (name, code, updated_at)
VALUES ('Timer Test Client', 'ZZ-TIMER-TEST', now());

INSERT INTO engagements (client_id, name, updated_at)
SELECT id, 'Timer Test Engagement', now() FROM clients WHERE code = 'ZZ-TIMER-TEST';

SELECT id AS alice_id FROM users WHERE email = 'alice.timer.test@example.invalid' \gset
SELECT id AS bob_id   FROM users WHERE email = 'bob.timer.test@example.invalid'   \gset

INSERT INTO tasks (display_key, title, engagement_id, created_by_id, assignee_id,
                   due_date, review_required, updated_at)
SELECT next_task_key(), 'Timer test task', e.id, :alice_id, :alice_id,
       CURRENT_DATE, false, now()
  FROM engagements e WHERE e.name = 'Timer Test Engagement';

SELECT id AS task_id FROM tasks WHERE title = 'Timer test task' \gset

\echo 'Fixtures created: 2 users, 1 client, 1 engagement, 1 task.'

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 1 — a user can start a timer ################'
\echo 'EXPECT: INSERT 0 1'

INSERT INTO time_entries (task_id, user_id, work_date, started_at, source)
VALUES (:task_id, :alice_id, CURRENT_DATE, now(), 'TIMER');

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 2 — MUST FAIL — same user, second timer ################'
\echo 'EXPECT: ERROR duplicate key ... "uniq_running_timer_per_user"'
\echo 'This is the race-condition guard. An ERROR here means the test PASSED.'

SAVEPOINT t2;
INSERT INTO time_entries (task_id, user_id, work_date, started_at, source)
VALUES (:task_id, :alice_id, CURRENT_DATE, now(), 'TIMER');
ROLLBACK TO SAVEPOINT t2;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 3 — a DIFFERENT user can hold their own timer ################'
\echo 'EXPECT: INSERT 0 1  (the constraint is per-user, not global)'

INSERT INTO time_entries (task_id, user_id, work_date, started_at, source)
VALUES (:task_id, :bob_id, CURRENT_DATE, now(), 'TIMER');

\echo 'Running timers now (expect 2 rows, one per user):'
SELECT user_id, source, started_at IS NOT NULL AS has_start, ended_at IS NULL AS still_running
  FROM time_entries WHERE ended_at IS NULL ORDER BY user_id;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 4 — stopping a timer frees the slot ################'
\echo 'EXPECT: UPDATE 1, then INSERT 0 1'

UPDATE time_entries
   SET ended_at = now(), duration_minutes = 25
 WHERE user_id = :alice_id AND ended_at IS NULL AND source = 'TIMER';

INSERT INTO time_entries (task_id, user_id, work_date, started_at, source)
VALUES (:task_id, :alice_id, CURRENT_DATE, now(), 'TIMER');

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 5 — completed sessions must not overlap ################'

-- Give Bob two clean, closed sessions to test the exclusion constraint against.
UPDATE time_entries
   SET ended_at = now(), duration_minutes = 10
 WHERE user_id = :bob_id AND ended_at IS NULL AND source = 'TIMER';

\echo ''
\echo '5a. A session 10:00-11:00 today. EXPECT: INSERT 0 1'
INSERT INTO time_entries (task_id, user_id, work_date, started_at, ended_at,
                          duration_minutes, source)
VALUES (:task_id, :bob_id, CURRENT_DATE,
        CURRENT_DATE + TIME '10:00', CURRENT_DATE + TIME '11:00', 60, 'TIMER');

\echo ''
\echo '5b. MUST FAIL — an overlapping session 10:30-11:30'
\echo 'EXPECT: ERROR conflicting key value violates exclusion constraint'
SAVEPOINT t5b;
INSERT INTO time_entries (task_id, user_id, work_date, started_at, ended_at,
                          duration_minutes, source)
VALUES (:task_id, :bob_id, CURRENT_DATE,
        CURRENT_DATE + TIME '10:30', CURRENT_DATE + TIME '11:30', 60, 'TIMER');
ROLLBACK TO SAVEPOINT t5b;

\echo ''
\echo '5c. An ADJACENT session 11:00-12:00. EXPECT: INSERT 0 1'
\echo '(tstzrange is half-open, so touching endpoints do not overlap.)'
INSERT INTO time_entries (task_id, user_id, work_date, started_at, ended_at,
                          duration_minutes, source)
VALUES (:task_id, :bob_id, CURRENT_DATE,
        CURRENT_DATE + TIME '11:00', CURRENT_DATE + TIME '12:00', 60, 'TIMER');

\echo ''
\echo '5d. The SAME window for a DIFFERENT user. EXPECT: INSERT 0 1'
\echo '(Two people may legitimately work the same hours.)'
UPDATE time_entries SET ended_at = now(), duration_minutes = 5
 WHERE user_id = :alice_id AND ended_at IS NULL AND source = 'TIMER';
INSERT INTO time_entries (task_id, user_id, work_date, started_at, ended_at,
                          duration_minutes, source)
VALUES (:task_id, :alice_id, CURRENT_DATE,
        CURRENT_DATE + TIME '10:00', CURRENT_DATE + TIME '11:00', 60, 'TIMER');

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 6 — guardrails on logged time ################'

\echo ''
\echo '6a. MUST FAIL — 9 hours in one entry with no note'
\echo 'EXPECT: ERROR ... "note_required_for_long_entries"'
SAVEPOINT t6a;
INSERT INTO time_entries (task_id, user_id, work_date, duration_minutes, source)
VALUES (:task_id, :alice_id, CURRENT_DATE, 540, 'MANUAL');
ROLLBACK TO SAVEPOINT t6a;

\echo ''
\echo '6b. The same 9 hours WITH a note. EXPECT: INSERT 0 1'
INSERT INTO time_entries (task_id, user_id, work_date, duration_minutes, source, note)
VALUES (:task_id, :alice_id, CURRENT_DATE, 540, 'MANUAL', 'Year-end stock count at client premises');

\echo ''
\echo '6c. MUST FAIL — negative duration. EXPECT: ERROR ... "duration_non_negative"'
SAVEPOINT t6c;
INSERT INTO time_entries (task_id, user_id, work_date, duration_minutes, source)
VALUES (:task_id, :alice_id, CURRENT_DATE, -30, 'MANUAL');
ROLLBACK TO SAVEPOINT t6c;

\echo ''
\echo '6d. MUST FAIL — a timer session ending before it starts'
\echo 'EXPECT: ERROR ... "timer_ends_after_it_starts"'
SAVEPOINT t6d;
INSERT INTO time_entries (task_id, user_id, work_date, started_at, ended_at,
                          duration_minutes, source)
VALUES (:task_id, :alice_id, CURRENT_DATE,
        CURRENT_DATE + TIME '15:00', CURRENT_DATE + TIME '14:00', 60, 'TIMER');
ROLLBACK TO SAVEPOINT t6d;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 7 — subtask depth is capped at one level ################'

INSERT INTO tasks (display_key, title, engagement_id, created_by_id, assignee_id,
                   due_date, review_required, parent_task_id, updated_at)
SELECT next_task_key(), 'Subtask level 1', engagement_id, :alice_id, :alice_id,
       CURRENT_DATE, false, :task_id, now()
  FROM tasks WHERE id = :task_id;

SELECT id AS subtask_id FROM tasks WHERE title = 'Subtask level 1' \gset
\echo '7a. A subtask of a root task. EXPECT: INSERT 0 1 (above)'

\echo ''
\echo '7b. MUST FAIL — a subtask OF a subtask'
\echo 'EXPECT: ERROR Subtasks are capped at one level'
SAVEPOINT t7b;
INSERT INTO tasks (display_key, title, engagement_id, created_by_id, assignee_id,
                   due_date, review_required, parent_task_id, updated_at)
SELECT next_task_key(), 'Subtask level 2', engagement_id, :alice_id, :alice_id,
       CURRENT_DATE, false, :subtask_id, now()
  FROM tasks WHERE id = :task_id;
ROLLBACK TO SAVEPOINT t7b;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 8 — task invariants ################'

\echo ''
\echo '8a. MUST FAIL — reviewer is the assignee. EXPECT: ERROR ... "reviewer_is_not_assignee"'
SAVEPOINT t8a;
UPDATE tasks SET reviewer_id = :alice_id WHERE id = :task_id;
ROLLBACK TO SAVEPOINT t8a;

\echo ''
\echo '8b. MUST FAIL — blocked with no reason. EXPECT: ERROR ... "blocked_needs_reason"'
SAVEPOINT t8b;
UPDATE tasks SET is_blocked = true WHERE id = :task_id;
ROLLBACK TO SAVEPOINT t8b;

\echo ''
\echo '8c. Blocked WITH a reason. EXPECT: UPDATE 1'
UPDATE tasks SET is_blocked = true, blocked_reason = 'Awaiting client bank statements',
                 blocked_since = now()
 WHERE id = :task_id;

\echo ''
\echo '8d. MUST FAIL — due date past the statutory ceiling'
\echo 'EXPECT: ERROR ... "due_within_statutory_ceiling"'
SAVEPOINT t8d;
UPDATE tasks SET statutory_due_date = CURRENT_DATE, due_date = CURRENT_DATE + 5
 WHERE id = :task_id;
ROLLBACK TO SAVEPOINT t8d;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ TEST 9 — full-text search vector is populated ################'
\echo 'EXPECT: a tsvector containing the task title and the client name'

SELECT left(search_vector::text, 160) AS search_vector_preview
  FROM tasks WHERE id = :task_id;

\echo ''
\echo 'Searching for "timer" via the GIN index. EXPECT: at least 1 row'
SELECT display_key, title
  FROM tasks
 WHERE search_vector @@ plainto_tsquery('english', 'timer')
 ORDER BY id;

-- ═══════════════════════════════════════════════════════════════
\echo ''
\echo '################ ROLLING BACK — nothing above is kept ################'
ROLLBACK;

\echo ''
\echo '=== CONFIRMING THE DATABASE IS UNCHANGED (all counts must be 0) ==='
SELECT
  (SELECT count(*) FROM users)        AS users,
  (SELECT count(*) FROM clients)      AS clients,
  (SELECT count(*) FROM engagements)  AS engagements,
  (SELECT count(*) FROM tasks)        AS tasks,
  (SELECT count(*) FROM time_entries) AS time_entries;

\echo ''
\echo '=== TIMER TESTS COMPLETE ==='
