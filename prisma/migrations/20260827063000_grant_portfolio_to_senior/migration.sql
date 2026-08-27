-- Grant view.portfolio to the Senior role.
--
-- ---------------------------------------------------------------------------
-- WHY: a manager already sees every task they oversee on the Team dashboard.
-- Without this capability they could see that list and not search it, because
-- the Browse screen was gated on view.portfolio while only Partner and
-- Administrator held it.
--
-- This grants NO ADDITIONAL DATA. view.portfolio is a SCREEN gate — the
-- relationship filter (visibleTaskFilter) still decides which tasks come back,
-- for every role. The capability that DOES bypass that filter is
-- view.all_tasks, which remains with administrators alone and is deliberately
-- not touched here.
--
-- DEFAULT_ROLES in src/lib/auth/capabilities.ts is the source of truth for new
-- installations; this statement brings existing rows into line with it.
-- ---------------------------------------------------------------------------

UPDATE roles
   SET capabilities = array_append(capabilities, 'view.portfolio')
 WHERE key = 'senior'
   AND NOT ('view.portfolio' = ANY (capabilities));

-- Fail loudly rather than silently leaving a role short. A migration that
-- quietly did nothing would be indistinguishable from one that worked, and the
-- symptom — a missing nav link — is easy to blame on the front end.
DO $$
DECLARE
  missing int;
BEGIN
  SELECT count(*) INTO missing
    FROM roles
   WHERE key = 'senior'
     AND NOT ('view.portfolio' = ANY (capabilities));

  IF missing > 0 THEN
    RAISE EXCEPTION
      'grant_portfolio_to_senior: % senior role(s) still lack view.portfolio', missing;
  END IF;
END $$;

-- Guard the thing this must never do. view.all_tasks bypasses the relationship
-- model entirely; if it ever appears on a non-admin role, something has gone
-- badly wrong and the migration should stop rather than proceed.
DO $$
DECLARE
  leaked int;
BEGIN
  SELECT count(*) INTO leaked
    FROM roles
   WHERE key <> 'admin'
     AND 'view.all_tasks' = ANY (capabilities);

  IF leaked > 0 THEN
    RAISE EXCEPTION
      'grant_portfolio_to_senior: % non-admin role(s) hold view.all_tasks', leaked;
  END IF;
END $$;
