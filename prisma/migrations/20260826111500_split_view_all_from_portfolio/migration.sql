-- ═══════════════════════════════════════════════════════════════════════════
-- Separate "unrestricted access" from "may browse the portfolio screen".
--
-- ── What went wrong ────────────────────────────────────────────────────────
-- The previous migration seeded the Partner role with `view.all_tasks`, on the
-- assumption that the capability meant "may open the All Tasks screen".
--
-- It does not. `view.all_tasks` is the one capability that BYPASSES THE
-- RELATIONSHIP MODEL ENTIRELY in visibleTaskFilter. Granting it to Partner
-- gave every partner read access to every other partner's client portfolio —
-- in a professional services firm, precisely the confidentiality boundary that
-- must never leak.
--
-- The permission suite caught it (3 failures across partner visibility).
-- Nothing else would have: the application looked completely normal, partners
-- simply saw more than they should.
--
-- ── The fix ────────────────────────────────────────────────────────────────
--   view.all_tasks  unrestricted bypass          → administrators only
--   view.portfolio  cross-engagement SCREEN gate → partners and administrators
--
-- Everything the portfolio screen renders still passes through
-- visibleTaskFilter, so a partner browsing "All tasks" sees their own clients
-- across every engagement, and nobody else's.
--
-- ── Why a new migration rather than editing the old one ────────────────────
-- The previous migration has been applied and its checksum recorded. Editing
-- it would break `prisma migrate` on any database that already ran it, and
-- would quietly rewrite history that other environments have acted on.
-- Corrections go forward.
-- ═══════════════════════════════════════════════════════════════════════════

-- Partner: swap the bypass for the screen gate.
UPDATE "roles"
   SET "capabilities" = array_remove("capabilities", 'view.all_tasks')
                        || ARRAY['view.portfolio']::text[],
       "updated_at"   = now()
 WHERE "key" = 'partner'
   AND 'view.all_tasks' = ANY("capabilities");

-- Administrators keep the bypass and gain the screen gate, since the screen is
-- gated on holding one or the other.
UPDATE "roles"
   SET "capabilities" = "capabilities" || ARRAY['view.portfolio']::text[],
       "updated_at"   = now()
 WHERE "key" = 'admin'
   AND NOT ('view.portfolio' = ANY("capabilities"));

-- Refuse to complete if any non-administrator still holds the bypass. Prisma
-- runs migrations in a transaction, so this rolls the whole thing back rather
-- than leaving a half-corrected permission model in place.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT "key", ', ') INTO offenders
    FROM "roles"
   WHERE 'view.all_tasks' = ANY("capabilities")
     AND "key" <> 'admin';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Non-administrator role(s) still hold view.all_tasks: %. That capability bypasses all relationship checks.',
      offenders;
  END IF;
END
$$;
