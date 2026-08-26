-- ═══════════════════════════════════════════════════════════════════════════
-- Add the Organization entity and attach users, teams and clients to it.
--
-- ⚠ HAND-EDITED. Prisma generated three `ADD COLUMN ... NOT NULL` statements
-- against tables that already hold rows, plus a CREATE TABLE placed AFTER the
-- foreign keys that reference it. Both would fail. The order below is the one
-- that actually works:
--
--   1. create the table
--   2. insert the organisation
--   3. add the columns NULLABLE
--   4. backfill
--   5. tighten to NOT NULL
--   6. add the foreign keys
--
-- This is the standard four-step column addition. Prisma cannot infer it
-- because it has no way to know what value existing rows should get.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The organisation ────────────────────────────────────────────────────
CREATE TABLE "organizations" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "logo_url" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "date_format" TEXT NOT NULL DEFAULT 'dd MMM yyyy',
    "week_starts_on" INTEGER NOT NULL DEFAULT 1,
    "working_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "task_key_prefix" TEXT NOT NULL DEFAULT 'TSK',
    "search_language" TEXT NOT NULL DEFAULT 'english',
    "terminology" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- ── 2. Seed the single organisation ────────────────────────────────────────
-- A NEUTRAL placeholder, deliberately. A firm name hardcoded in a migration
-- would be the exact CA-specific assumption this work exists to remove — and
-- this file also runs on staging and production. The real name, logo and
-- timezone are set by the seed script or by an administrator.
--
-- The column DEFAULTS above carry this installation's sensible starting point
-- (IST, dd MMM yyyy, six-day working week). Those are defaults, not facts.
INSERT INTO "organizations" ("name", "updated_at")
VALUES ('Default Organisation', now());

-- ── 3. Add the columns, nullable for now ───────────────────────────────────
ALTER TABLE "users"   ADD COLUMN "organization_id" BIGINT;
ALTER TABLE "teams"   ADD COLUMN "organization_id" BIGINT;
ALTER TABLE "clients" ADD COLUMN "organization_id" BIGINT;

-- ── 4. Backfill ────────────────────────────────────────────────────────────
-- Every existing row belongs to the one organisation. `LIMIT 1` on an ordered
-- select rather than a hardcoded id, so this is correct whether the sequence
-- started at 1 or the table was seeded some other way.
UPDATE "users"   SET "organization_id" = (SELECT "id" FROM "organizations" ORDER BY "id" LIMIT 1);
UPDATE "teams"   SET "organization_id" = (SELECT "id" FROM "organizations" ORDER BY "id" LIMIT 1);
UPDATE "clients" SET "organization_id" = (SELECT "id" FROM "organizations" ORDER BY "id" LIMIT 1);

-- ── 5. Now they can be required ────────────────────────────────────────────
ALTER TABLE "users"   ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "teams"   ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "clients" ALTER COLUMN "organization_id" SET NOT NULL;

-- ── 6. Foreign keys ────────────────────────────────────────────────────────
-- RESTRICT on delete: removing an organisation while its people and clients
-- still exist should fail loudly, not cascade away the entire installation.
ALTER TABLE "users"
  ADD CONSTRAINT "users_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clients"
  ADD CONSTRAINT "clients_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes for the tenant predicate that will exist if this ever becomes
-- genuinely multi-organisation. Cheap now, and they make the FK checks faster
-- regardless.
CREATE INDEX "users_organization_id_idx"   ON "users"("organization_id");
CREATE INDEX "teams_organization_id_idx"   ON "teams"("organization_id");
CREATE INDEX "clients_organization_id_idx" ON "clients"("organization_id");
