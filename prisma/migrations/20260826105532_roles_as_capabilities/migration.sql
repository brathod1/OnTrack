-- ═══════════════════════════════════════════════════════════════════════════
-- Roles become rows carrying capabilities, replacing the hardcoded Role enum.
--
-- ⚠ HAND-EDITED. Prisma generated this as its first statement:
--
--     ALTER TABLE "users" DROP COLUMN "role", ADD COLUMN "role_id" BIGINT NOT NULL;
--
-- which destroys every user's role and then fails on the NOT NULL — before
-- the roles table it references has even been created. The order below is the
-- one that preserves the data:
--
--   1. create roles
--   2. seed the default roles for every organisation
--   3. add users.role_id NULLABLE
--   4. backfill by MAPPING the old enum value
--   5. verify nobody was missed, and abort the migration if so
--   6. tighten to NOT NULL, index, foreign key
--   7. only now drop the old column and the enum type
--
-- Step 4 is the one that matters. Get the mapping wrong and there is no error:
-- everyone silently becomes Staff, nobody can assign work, and the only thing
-- that notices is the test suite.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The roles table ─────────────────────────────────────────────────────
CREATE TABLE "roles" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" BIGINT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "roles_organization_id_idx" ON "roles"("organization_id");
CREATE UNIQUE INDEX "roles_organization_id_key_key" ON "roles"("organization_id", "key");

ALTER TABLE "roles"
  ADD CONSTRAINT "roles_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. Seed the default roles, for every organisation ──────────────────────
-- CROSS JOIN so this is correct whether there is one organisation or ten.
-- The capability lists must stay in step with DEFAULT_ROLES in
-- src/lib/auth/capabilities.ts — that file is the source of truth for what
-- each capability MEANS; this is a starting point for what each role HOLDS.
INSERT INTO "roles" ("organization_id", "key", "label", "description",
                     "capabilities", "is_system", "sort_order", "updated_at")
SELECT o."id", v.key, v.label, v.description, v.caps, v.is_system, v.sort_order, now()
  FROM "organizations" o
 CROSS JOIN (VALUES
   (
     'admin', 'Administrator',
     'Full access, including users, work areas and configuration.',
     ARRAY[
       'task.create','task.assign','task.set_deadline','task.set_external_deadline',
       'task.set_priority','task.cancel','task.reopen','task.review',
       'time.log','time.edit_others',
       'view.all_tasks','view.reports','view.audit_log',
       'manage.users','manage.work_areas','manage.organization'
     ]::text[],
     true, 1
   ),
   (
     'partner', 'Partner',
     'Oversees clients and engagements. Sees all work, directs it, and reviews.',
     ARRAY[
       'task.create','task.assign','task.set_deadline','task.set_priority',
       'task.cancel','task.reopen','task.review',
       'time.log','time.edit_others',
       'view.all_tasks','view.reports','view.audit_log','manage.work_areas'
     ]::text[],
     false, 2
   ),
   (
     'senior', 'Senior',
     'Runs engagements and a team. Assigns work, moves deadlines, reviews.',
     ARRAY[
       'task.create','task.assign','task.set_deadline','task.set_priority',
       'task.cancel','task.reopen','task.review',
       'time.log','time.edit_others','view.reports'
     ]::text[],
     false, 3
   ),
   (
     'staff', 'Staff',
     'Does the work. Updates their own tasks, logs time, comments.',
     -- Note what is ABSENT: no assign, no deadline, no priority. A person who
     -- can move their own due date makes deadlines meaningless.
     ARRAY['task.create','time.log']::text[],
     false, 4
   )
 ) AS v(key, label, description, caps, is_system, sort_order);

-- ── 3. Add the column, nullable for now ────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "role_id" BIGINT;

-- ── 4. Backfill by mapping the old enum value ──────────────────────────────
-- MANAGER maps to 'senior' because that is what a professional services firm
-- calls the role. PARTNER keeps a role of its own rather than collapsing into
-- senior: partners hold view.all_tasks, and merging them would silently WIDEN
-- what every Senior can see.
UPDATE "users" u
   SET "role_id" = r."id"
  FROM "roles" r
 WHERE r."organization_id" = u."organization_id"
   AND r."key" = CASE u."role"::text
                   WHEN 'ADMIN'   THEN 'admin'
                   WHEN 'PARTNER' THEN 'partner'
                   WHEN 'MANAGER' THEN 'senior'
                   WHEN 'MEMBER'  THEN 'staff'
                 END;

-- ── 5. Refuse to continue if anyone was missed ─────────────────────────────
-- Prisma runs a migration in a transaction, so raising here rolls back
-- everything above. A silent partial backfill would leave users with a NULL
-- role that the next statement turns into a hard failure with no explanation
-- of which rows or why.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans FROM "users" WHERE "role_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Role backfill missed % user(s). Unmapped role values: %',
      orphans,
      (SELECT string_agg(DISTINCT "role"::text, ', ') FROM "users" WHERE "role_id" IS NULL);
  END IF;
END
$$;

-- ── 6. Now it can be required ──────────────────────────────────────────────
ALTER TABLE "users" ALTER COLUMN "role_id" SET NOT NULL;

CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- RESTRICT: deleting a role while people still hold it should fail loudly
-- rather than cascade users away or leave them role-less.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 7. Retire the enum ─────────────────────────────────────────────────────
ALTER TABLE "users" DROP COLUMN "role";
DROP TYPE "Role";
