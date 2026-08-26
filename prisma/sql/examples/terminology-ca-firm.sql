-- ═══════════════════════════════════════════════════════════════════════════
-- OnTrack configured for a CHARTERED ACCOUNTANCY FIRM — the default.
--
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/examples/terminology-ca-firm.sql
--
-- These are the same values as DEFAULT_TERMS in src/lib/org/terminology.ts,
-- so an organisation that configures nothing already gets this. Written out
-- explicitly here as the counterpart to the software-company example, and to
-- restore the vocabulary after trying that one.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "organizations"
   SET "terminology" = '{
         "client":            { "singular": "Client",     "plural": "Clients" },
         "engagement":        { "singular": "Engagement", "plural": "Engagements" },
         "task":              { "singular": "Task",       "plural": "Tasks" },
         "subtask":           { "singular": "Subtask",    "plural": "Subtasks" },
         "team":              { "singular": "Team",       "plural": "Teams" },
         "review":            { "singular": "Review",     "plural": "Reviews" },
         "externalDeadline":  { "singular": "Statutory deadline", "plural": "Statutory deadlines", "short": "Stat" },
         "committedDeadline": { "singular": "Client commitment",  "plural": "Client commitments",  "short": "Committed" },
         "internalDeadline":  { "singular": "Internal target",    "plural": "Internal targets",    "short": "Internal" }
       }'::jsonb,
       "updated_at" = now();

SELECT "name",
       "terminology" -> 'client' ->> 'plural'          AS nav_label,
       "terminology" -> 'engagement' ->> 'singular'    AS work_container,
       "terminology" -> 'externalDeadline' ->> 'short' AS deadline_badge
  FROM "organizations";
