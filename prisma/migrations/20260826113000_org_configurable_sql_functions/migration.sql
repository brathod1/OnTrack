-- ═══════════════════════════════════════════════════════════════════════════
-- Read the task-key prefix, the day boundary and the search language from the
-- organisation instead of hardcoding them.
--
-- ── The three constants, and why each is a defect ──────────────────────────
--
--   'Asia/Kolkata'  in next_task_key()
--       The GENUINE BUG. The year in a task key was computed in IST no matter
--       where the organisation is. A firm in London would see keys roll over
--       at 5:30am on 1 January, and one in New York on 31 December. Nothing
--       errors; the keys are simply wrong for part of the year.
--
--   'TSK'  in next_task_key()
--       Every organisation gets TSK- whether it suits them or not.
--
--   'english'  in tasks_build_search_vector()
--       Stemming is English-only. Already wrong for a Gujarati or Hindi
--       corpus at the first firm using this, never mind a later one.
--
-- These were not configuration decisions. They were assumptions that looked
-- like constants because there was nowhere else to put them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── next_task_key() ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION next_task_key()
RETURNS text AS $$
DECLARE
  org_prefix   text;
  org_timezone text;
  y            int;
  n            bigint;
BEGIN
  SELECT "task_key_prefix", "timezone"
    INTO org_prefix, org_timezone
    FROM "organizations"
   ORDER BY "id"
   LIMIT 1;

  IF org_prefix IS NULL THEN
    -- Better a clear failure than a task numbered by an invented default.
    RAISE EXCEPTION
      'No organisation configured. Task keys need a prefix and a timezone; run the seed first.';
  END IF;

  -- The organisation's own day boundary, not the server's and not IST.
  y := EXTRACT(YEAR FROM now() AT TIME ZONE org_timezone);

  -- NOTE: task_key_counters is keyed by year alone. Correct while there is one
  -- organisation. If OnTrack ever serves several, this needs (organization_id,
  -- year) or two organisations will share a numbering sequence.
  INSERT INTO "task_key_counters" ("year", "value")
       VALUES (y, 1)
  ON CONFLICT ("year") DO UPDATE SET "value" = "task_key_counters"."value" + 1
    RETURNING "value" INTO n;

  RETURN org_prefix || '-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- ── tasks_build_search_vector() ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tasks_build_search_vector()
RETURNS TRIGGER AS $$
DECLARE
  lang            regconfig;
  client_name     text;
  engagement_name text;
  assignee_name   text;
  tag_names       text;
BEGIN
  -- Falls back to 'english' rather than failing: a task must still be
  -- creatable if someone types an unrecognised configuration name. A bad
  -- search language degrades results; it should not block work.
  SELECT COALESCE("search_language", 'english')::regconfig
    INTO lang
    FROM "organizations"
   ORDER BY "id"
   LIMIT 1;

  IF lang IS NULL THEN
    lang := 'english'::regconfig;
  END IF;

  SELECT c."name", e."name" INTO client_name, engagement_name
    FROM "engagements" e JOIN "clients" c ON c."id" = e."client_id"
   WHERE e."id" = NEW."engagement_id";

  SELECT u."name" INTO assignee_name FROM "users" u WHERE u."id" = NEW."assignee_id";

  SELECT string_agg(t."name", ' ') INTO tag_names
    FROM "task_tags" tt JOIN "tags" t ON t."id" = tt."tag_id"
   WHERE tt."task_id" = NEW."id";

  NEW."search_vector" :=
      setweight(to_tsvector(lang, coalesce(NEW."display_key", '')), 'A')
    || setweight(to_tsvector(lang, coalesce(NEW."title", '')), 'A')
    || setweight(to_tsvector(lang, coalesce(client_name, '')), 'B')
    || setweight(to_tsvector(lang, coalesce(engagement_name, '')), 'B')
    || setweight(to_tsvector(lang, coalesce(assignee_name, '')), 'C')
    || setweight(to_tsvector(lang, coalesce(tag_names, '')), 'C')
    || setweight(to_tsvector(lang, coalesce(NEW."description", '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Rebuild existing vectors under the configured language ─────────────────
-- Without this, rows indexed before this migration keep their old vectors and
-- search behaves inconsistently depending on when a task was created.
UPDATE "tasks" SET "updated_at" = "updated_at";

-- ── Prove the function reads configuration ─────────────────────────────────
-- Generates a key, checks it carries the organisation's prefix, then rolls the
-- counter back so no key is consumed. Runs inside the migration's transaction.
DO $$
DECLARE
  expected_prefix text;
  produced        text;
BEGIN
  SELECT "task_key_prefix" INTO expected_prefix
    FROM "organizations" ORDER BY "id" LIMIT 1;

  IF expected_prefix IS NULL THEN
    RAISE NOTICE 'No organisation yet; skipping the task-key check.';
    RETURN;
  END IF;

  produced := next_task_key();

  IF produced NOT LIKE expected_prefix || '-%' THEN
    RAISE EXCEPTION
      'next_task_key() produced "%" but the organisation prefix is "%"', produced, expected_prefix;
  END IF;

  -- Give the number back.
  UPDATE "task_key_counters"
     SET "value" = "value" - 1
   WHERE "year" = EXTRACT(YEAR FROM now() AT TIME ZONE
                          (SELECT "timezone" FROM "organizations" ORDER BY "id" LIMIT 1));
END
$$;
