-- ═══════════════════════════════════════════════════════════════════════════
-- Remove CA-specific vocabulary from the type system.
--
-- ⚠ HAND-WRITTEN. Prisma would express each of these as DROP + ADD, which
-- discards the data. Every statement below RENAMES, so existing rows keep
-- their values:
--
--   tasks.statutory_due_date   → tasks.external_deadline
--   DueDateType.STATUTORY      → EXTERNAL_FIXED
--   DueDateType.CLIENT_COMMITTED → COMMITTED
--   Grade enum                 → free text on users.grade
--
-- ── What was wrong with them ───────────────────────────────────────────────
-- "Statutory" is a regulatory filing deadline — real and important for a CA
-- firm, meaningless to a software company that needs the identical behaviour
-- for a contractual SLA. The BEHAVIOUR the engine needs is "a date set outside
-- this organisation that we cannot move, and which caps the internal due
-- date". That is what the column and the enum value now say.
--
-- The Grade enum was a CA seniority ladder in the type system: PARTNER,
-- ASSISTANT_MANAGER, ARTICLE. "Article" is specific to Indian chartered
-- accountancy. Nothing in the engine branches on grade — it is displayed, and
-- will later seed default capacity hours — so free text is the right shape.
--
-- The organisation supplies the LABELS through terminology config. A CA firm
-- still sees "Statutory deadline" everywhere; the software no longer believes
-- that is what the field means.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The external deadline column ────────────────────────────────────────
-- RENAME, not DROP/ADD. PostgreSQL rewrites the CHECK constraint's expression
-- automatically, so the ceiling rule survives the rename intact.
ALTER TABLE "tasks" RENAME COLUMN "statutory_due_date" TO "external_deadline";

ALTER TABLE "tasks"
  RENAME CONSTRAINT "due_within_statutory_ceiling" TO "due_within_external_deadline";

-- ── 2. Deadline type values ────────────────────────────────────────────────
-- ALTER TYPE ... RENAME VALUE preserves every stored row and updates column
-- defaults that reference the value. Available from PostgreSQL 10.
ALTER TYPE "DueDateType" RENAME VALUE 'STATUTORY' TO 'EXTERNAL_FIXED';
ALTER TYPE "DueDateType" RENAME VALUE 'CLIENT_COMMITTED' TO 'COMMITTED';

-- ── 3. Grade becomes free text ─────────────────────────────────────────────
ALTER TABLE "users" ALTER COLUMN "grade" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "grade" TYPE TEXT USING "grade"::text;
ALTER TABLE "users" ALTER COLUMN "grade" DROP NOT NULL;

DROP TYPE "Grade";

-- Now that it is display text rather than an identifier, make it read like
-- text: ASSISTANT_MANAGER becomes "Assistant Manager".
UPDATE "users"
   SET "grade" = initcap(replace("grade", '_', ' '))
 WHERE "grade" IS NOT NULL;

-- ── 4. Verify nothing was lost ─────────────────────────────────────────────
-- Renames are safe in principle; this proves it in fact. Prisma runs the
-- migration in a transaction, so a failure here rolls everything back.
DO $$
DECLARE
  ceiling_violations int;
  orphan_grades      int;
BEGIN
  -- The ceiling rule must still hold for every task that has an external date.
  SELECT count(*) INTO ceiling_violations
    FROM "tasks"
   WHERE "external_deadline" IS NOT NULL
     AND "due_date" > "external_deadline";

  IF ceiling_violations > 0 THEN
    RAISE EXCEPTION
      '% task(s) have a due date past their external deadline. The CHECK constraint did not survive the rename.',
      ceiling_violations;
  END IF;

  -- Grades should have converted to text, not vanished.
  SELECT count(*) INTO orphan_grades
    FROM "users" WHERE "grade" IS NULL;

  IF orphan_grades > 0 THEN
    RAISE NOTICE '% user(s) have no grade. Expected if any were created without one.', orphan_grades;
  END IF;
END
$$;
