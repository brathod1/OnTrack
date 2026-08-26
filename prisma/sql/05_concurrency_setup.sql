-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 05_concurrency_setup.sql
--
-- Fixtures for the two-session timer concurrency test.
--
-- RUN AS: ontrack_owner, connected to ontrack.
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/05_concurrency_setup.sql
--
-- ⚠ THIS ONE COMMITS. Unlike 04_timer_tests.sql, these rows must persist so
-- that two separate psql sessions can both see them — that is the entire point
-- of the test. Run 06_concurrency_cleanup.sql afterwards to remove them.
--
-- Everything created here is prefixed ZZ- or uses an @example.invalid address,
-- so it is unmistakably test data. `.invalid` is reserved by RFC 2606 and can
-- never be a real domain.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO users (email, name, role, grade, status, updated_at)
VALUES ('carol.concurrency@example.invalid', 'Carol Concurrency',
        'MEMBER', 'SENIOR', 'ACTIVE', now());

INSERT INTO clients (name, code, updated_at)
VALUES ('ZZ Concurrency Test Client', 'ZZ-CONC-TEST', now());

INSERT INTO engagements (client_id, name, updated_at)
SELECT id, 'ZZ Concurrency Test Engagement', now()
  FROM clients WHERE code = 'ZZ-CONC-TEST';

INSERT INTO tasks (display_key, title, engagement_id, created_by_id, assignee_id,
                   due_date, review_required, updated_at)
SELECT next_task_key(), 'ZZ Concurrency test task', e.id, u.id, u.id,
       CURRENT_DATE, false, now()
  FROM engagements e, users u
 WHERE e.name = 'ZZ Concurrency Test Engagement'
   AND u.email = 'carol.concurrency@example.invalid';

COMMIT;

\echo ''
\echo '=== FIXTURES COMMITTED ==='
SELECT t.display_key, t.title, u.name AS assignee
  FROM tasks t JOIN users u ON u.id = t.assignee_id
 WHERE t.title = 'ZZ Concurrency test task';

\echo ''
\echo 'Now run the two-window test. Both windows paste IDENTICAL text -'
\echo 'the statements look users and tasks up by name, so there are no ids'
\echo 'to copy and no chance of the two windows disagreeing.'
\echo ''
\echo 'When finished, run: prisma/sql/06_concurrency_cleanup.sql'
