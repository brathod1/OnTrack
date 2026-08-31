-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 02_grants.sql
--
-- WHEN TO RUN: AFTER the Prisma migration has created the tables. Re-run after
--              any migration that adds a table (or rely on the ALTER DEFAULT
--              PRIVILEGES block at the end, which covers future tables).
-- RUN AS:      `ontrack_owner` is SUFFICIENT for this file, and is what
--              `npm run db:test` uses. The postgres superuser is required for
--              the INITIAL setup only — CREATE DATABASE, and 00_roles.sql,
--              which creates roles. This file creates nothing: it grants and
--              revokes on objects that already exist, and in PostgreSQL you
--              may grant on what you own. ontrack_owner owns the database, the
--              public schema (via pg_database_owner) and every table in it.
--
--              Using the superuser here meant a password that lives nowhere in
--              the project, so the script that runs this could only ever work
--              with a human present to type it.
-- DESTRUCTIVE: no. Grants and revokes privileges. Touches no data.
--
--   psql -v ON_ERROR_STOP=1 -U ontrack_owner -h localhost -d ontrack -f prisma/sql/02_grants.sql
--
-- ON_ERROR_STOP=1 matters: without it psql skips a failing statement and still
-- exits 0, so a half-applied grants run looks like a successful one.
--
-- ── Why this file exists ───────────────────────────────────────────────────
-- The activity log must be append-only. "The application never updates it" is
-- a convention that survives exactly until someone writes a well-meaning
-- cleanup script. Withholding UPDATE and DELETE from the role the application
-- connects as is a guarantee the database enforces.
--
-- The same reasoning covers time entries, tasks, comments and users: deletion
-- is a soft flag with a reason, so a stray `prisma.task.delete()` should fail
-- loudly in development rather than quietly destroy a week of someone's work
-- in production.
--
-- NOTE: this file previously also created roles and assumed the tables already
-- existed. Role creation now lives in 00_roles.sql, which runs BEFORE the
-- migration. This file runs AFTER it. The ordering matters — the REVOKE
-- statements below fail if the tables do not yet exist.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Connection and schema access ────────────────────────────────────────

-- PostgreSQL grants CONNECT to PUBLIC on every new database, which means any
-- role that can log in to the server can reach this one. Revoke that first, so
-- connection is by explicit grant only.
--
-- Uses current_database() rather than a literal name so the same file works
-- unchanged against ontrack, ontrack_test, staging and production. A hardcoded
-- name would silently grant on the wrong database when run elsewhere — the
-- worst kind of bug, because everything appears to succeed.
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ontrack_owner, ontrack_app, ontrack_readonly',
                 current_database());
  RAISE NOTICE 'CONNECT scoped to named roles on database %', current_database();
END
$$;
GRANT USAGE  ON SCHEMA   public   TO ontrack_app, ontrack_readonly;

-- The migration role owns everything in the schema.
GRANT ALL ON SCHEMA public TO ontrack_owner;

-- ── 2. Baseline DML for the application ────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO ontrack_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO ontrack_app;

-- ── 3. Append-only activity log ────────────────────────────────────────────

REVOKE UPDATE, DELETE, TRUNCATE ON activity_log FROM ontrack_app;
GRANT  SELECT, INSERT           ON activity_log TO   ontrack_app;

-- ── 4. Tables where deletion is always soft ────────────────────────────────

REVOKE DELETE, TRUNCATE ON time_entries FROM ontrack_app;
REVOKE DELETE, TRUNCATE ON tasks        FROM ontrack_app;
REVOKE DELETE, TRUNCATE ON comments     FROM ontrack_app;
REVOKE DELETE, TRUNCATE ON users        FROM ontrack_app;

-- Join rows genuinely are removable — nothing is lost by unlinking a tag or
-- removing a contributor, and both are recorded in the activity log anyway.
GRANT DELETE ON task_tags, task_contributors, engagement_members TO ontrack_app;

-- Notifications are ephemeral; clearing them destroys no record of work.
GRANT DELETE ON notifications TO ontrack_app;

-- ── 5. Defaults for tables added by future migrations ──────────────────────
-- FOR ROLE ontrack_owner is essential: default privileges apply only to
-- objects created BY the named role. Migrations run as ontrack_owner, so
-- without this clause new tables would arrive with no grants for the app and
-- the application would start failing on a table it had never heard of.

ALTER DEFAULT PRIVILEGES FOR ROLE ontrack_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ontrack_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ontrack_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ontrack_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ontrack_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO ontrack_readonly;

-- ── 6. Read-only role (reporting, later phases) ────────────────────────────

GRANT SELECT ON ALL TABLES IN SCHEMA public TO ontrack_readonly;

-- ── 7. Verification ────────────────────────────────────────────────────────
-- Prints the privileges that matter. Expect for ontrack_app:
--   activity_log  -> INSERT, SELECT   (and nothing else)
--   time_entries  -> INSERT, SELECT, UPDATE
--   tasks         -> INSERT, SELECT, UPDATE

SELECT table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.table_privileges
 WHERE grantee = 'ontrack_app'
   AND table_name IN ('activity_log', 'time_entries', 'tasks', 'comments',
                      'users', 'task_tags', 'notifications')
 GROUP BY table_name
 ORDER BY table_name;
