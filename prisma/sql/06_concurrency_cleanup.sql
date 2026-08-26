-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 06_concurrency_cleanup.sql
--
-- Removes the fixtures created by 05_concurrency_setup.sql.
--
-- RUN AS: ontrack_owner, connected to ontrack.
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/06_concurrency_cleanup.sql
--
-- ⚠ DESTRUCTIVE, but narrowly and deliberately so. Every DELETE below is
-- keyed to the specific test fixtures: the ZZ-CONC-TEST client code and the
-- carol.concurrency@example.invalid address. It cannot touch real data,
-- because no real client has that code and .invalid can never be a real
-- domain (RFC 2606).
--
-- Deletion order follows the foreign keys: time entries, then tasks, then the
-- engagement, then the client, then the user.
--
-- NOTE: this must run as ontrack_owner, not ontrack_app. The application role
-- deliberately has no DELETE on tasks, users or time_entries — deletion in
-- OnTrack is a soft flag with a reason. Needing elevated rights to clean up
-- test data is the grants working as designed.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DELETE FROM time_entries
 WHERE user_id IN (SELECT id FROM users WHERE email = 'carol.concurrency@example.invalid');

DELETE FROM tasks        WHERE title = 'ZZ Concurrency test task';
DELETE FROM engagements  WHERE name  = 'ZZ Concurrency Test Engagement';
DELETE FROM clients      WHERE code  = 'ZZ-CONC-TEST';
DELETE FROM users        WHERE email = 'carol.concurrency@example.invalid';

-- Reset the key counter so the first real task is TSK-2026-00001.
-- Safe ONLY while no real tasks exist. Once live, deleting this row would
-- cause duplicate task keys.
DELETE FROM task_key_counters;

COMMIT;

\echo ''
\echo '=== CLEANUP COMPLETE - ALL COUNTS MUST BE 0 ==='
SELECT
  (SELECT count(*) FROM users)             AS users,
  (SELECT count(*) FROM clients)           AS clients,
  (SELECT count(*) FROM engagements)       AS engagements,
  (SELECT count(*) FROM tasks)             AS tasks,
  (SELECT count(*) FROM time_entries)      AS time_entries,
  (SELECT count(*) FROM task_key_counters) AS key_counters;
