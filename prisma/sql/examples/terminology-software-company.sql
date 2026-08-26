-- ═══════════════════════════════════════════════════════════════════════════
-- Example: OnTrack configured for a SOFTWARE COMPANY.
--
--   psql -U ontrack_owner -h localhost -d ontrack -f prisma/sql/examples/terminology-software-company.sql
--
-- Changes vocabulary ONLY. No schema change, no deployment, no code path.
-- Run terminology-ca-firm.sql to put it back.
--
-- This file exists to be RUN, not just read: "the product is configurable" is
-- a claim, and a claim about configuration is worth exactly as much as the
-- demonstration that backs it.
--
-- Anything omitted keeps its default — the merge is field by field, so setting
-- only `client.singular` would leave the plural intact rather than blanking it.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "organizations"
   SET "terminology" = '{
         "client":            { "singular": "Customer",    "plural": "Customers" },
         "engagement":        { "singular": "Project",     "plural": "Projects" },
         "task":              { "singular": "Ticket",      "plural": "Tickets" },
         "subtask":           { "singular": "Sub-ticket",  "plural": "Sub-tickets" },
         "team":              { "singular": "Squad",       "plural": "Squads" },
         "review":            { "singular": "QA",          "plural": "QA" },
         "externalDeadline":  { "singular": "Contractual SLA", "plural": "SLAs",           "short": "SLA" },
         "committedDeadline": { "singular": "Customer promise", "plural": "Promises",      "short": "Promised" },
         "internalDeadline":  { "singular": "Sprint target",   "plural": "Sprint targets", "short": "Sprint" }
       }'::jsonb,
       "updated_at" = now();

SELECT "name",
       "terminology" -> 'client' ->> 'plural'          AS nav_label,
       "terminology" -> 'engagement' ->> 'singular'    AS work_container,
       "terminology" -> 'externalDeadline' ->> 'short' AS deadline_badge
  FROM "organizations";
