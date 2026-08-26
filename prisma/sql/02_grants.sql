-- OnTrack — database roles and grants.
-- Run ONCE as the database owner, after the first migration.
--
-- The point of this file: the activity log must be append-only, and the
-- cheapest honest way to guarantee that is to withhold UPDATE and DELETE from
-- the role the application connects as. Application-level "we never update it"
-- is a convention; this is a guarantee.

-- ── 1. The application role ────────────────────────────────────────────────
-- The app connects as ontrack_app, NOT as the database owner. Migrations run
-- separately as the owner (a different DATABASE_URL in CI).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontrack_app') THEN
    CREATE ROLE ontrack_app LOGIN PASSWORD 'set-me-from-key-vault';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE ontrack TO ontrack_app;
GRANT USAGE  ON SCHEMA public     TO ontrack_app;

-- Full DML on the working tables.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO ontrack_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ontrack_app;

-- ── 2. Append-only activity log ────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON activity_log FROM ontrack_app;
GRANT  SELECT, INSERT            ON activity_log TO   ontrack_app;

-- ── 3. Time entries are never hard-deleted ─────────────────────────────────
-- Deletion is a soft flag with a reason. Removing DELETE means a stray
-- `prisma.timeEntry.delete()` fails loudly in development rather than
-- quietly destroying somebody's week in production.
REVOKE DELETE, TRUNCATE ON time_entries FROM ontrack_app;

-- Same reasoning for the work record itself.
REVOKE DELETE, TRUNCATE ON tasks    FROM ontrack_app;
REVOKE DELETE, TRUNCATE ON comments FROM ontrack_app;
REVOKE DELETE, TRUNCATE ON users    FROM ontrack_app;

-- Join rows genuinely are removable — nothing is lost by unlinking a tag.
GRANT DELETE ON task_tags, task_contributors, engagement_members TO ontrack_app;

-- ── 4. Defaults for tables added by future migrations ──────────────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ontrack_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ontrack_app;

-- ── 5. Read-only role for reporting / Power BI (later phase) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontrack_readonly') THEN
    CREATE ROLE ontrack_readonly LOGIN PASSWORD 'set-me-from-key-vault';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE ontrack TO ontrack_readonly;
GRANT USAGE   ON SCHEMA public    TO ontrack_readonly;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO ontrack_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ontrack_readonly;
