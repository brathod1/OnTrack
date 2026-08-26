-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack — 00_roles.sql
--
-- WHEN TO RUN: once per environment, BEFORE the first Prisma migration.
-- RUN AS:      the postgres superuser, connected to the `postgres` database.
-- DESTRUCTIVE: no. Creates two roles if absent; touches nothing that exists.
--
-- Two roles, deliberately:
--
--   ontrack_owner — owns the schema. Prisma migrations connect as this role.
--                   Needs CREATEDB because `prisma migrate dev` builds a
--                   throwaway shadow database to diff against.
--
--   ontrack_app   — the running application. Restricted grants (02_grants.sql)
--                   are what make the activity log genuinely append-only,
--                   rather than append-only by convention.
--
-- Passwords are deliberately NOT set here. This file is committed to Git.
-- Set them interactively with psql's \password, which prompts without echoing
-- and never puts the password in a file or in shell history.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontrack_owner') THEN
    CREATE ROLE ontrack_owner LOGIN CREATEDB;
    RAISE NOTICE 'Created role ontrack_owner';
  ELSE
    RAISE NOTICE 'Role ontrack_owner already exists - left unchanged';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontrack_app') THEN
    CREATE ROLE ontrack_app LOGIN;
    RAISE NOTICE 'Created role ontrack_app';
  ELSE
    RAISE NOTICE 'Role ontrack_app already exists - left unchanged';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontrack_readonly') THEN
    CREATE ROLE ontrack_readonly LOGIN;
    RAISE NOTICE 'Created role ontrack_readonly';
  ELSE
    RAISE NOTICE 'Role ontrack_readonly already exists - left unchanged';
  END IF;
END
$$;

-- Show the result so the operator can see what happened.
SELECT rolname AS role, rolcanlogin AS can_login, rolcreatedb AS can_create_db
  FROM pg_roles
 WHERE rolname LIKE 'ontrack%'
 ORDER BY rolname;
