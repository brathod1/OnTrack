import { prisma } from "@/lib/db";

/**
 * Resolving "which organisation is this?"
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TODAY: there is exactly one organisation, and this returns it.
 *
 * The point of the indirection is that every caller asks a QUESTION rather
 * than assuming an ANSWER. When a second organisation eventually exists, the
 * resolution strategy changes here — from a subdomain, a custom domain, or the
 * signed-in user's own organizationId — and no caller changes at all.
 *
 * Without this, "the organisation" would be spelled `findFirst()` in fifteen
 * places, and making the system genuinely multi-organisation would mean
 * finding all fifteen.
 *
 * Deliberately NOT cached. It is a single indexed row on a one-row table;
 * PostgreSQL serves it from shared buffers. A cache here would buy microseconds
 * and cost a class of stale-configuration bug that is genuinely hard to
 * diagnose — an administrator changes the timezone and it takes effect on some
 * requests but not others.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type CurrentOrganization = Awaited<ReturnType<typeof getCurrentOrganization>>;

export async function getCurrentOrganization() {
  const org = await prisma.organization.findFirst({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      shortName: true,
      logoUrl: true,
      timezone: true,
      dateFormat: true,
      weekStartsOn: true,
      workingDays: true,
      taskKeyPrefix: true,
      searchLanguage: true,
      terminology: true,
    },
  });

  if (!org) {
    // Not a "maybe" — the application cannot function without one, and a
    // null-returning function here would push that check onto every caller.
    throw new Error(
      "No organisation found. Run `npm run db:seed`, or create one before starting the app."
    );
  }

  return org;
}

/**
 * The role a brand-new user should receive.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Chooses the LEAST PRIVILEGED role in the organisation — fewest capabilities,
 * breaking ties toward the one sorted last.
 *
 * Not "staff", because that is this firm's name for it and another
 * organisation may not have a role by that name at all. Not the first role
 * either, which in most orderings is the administrator.
 *
 * The safety argument matters more than the naming one. This runs when a
 * stranger signs in through the identity provider for the first time. They
 * are created PENDING and refused entry until an administrator approves them,
 * so the role is provisional — but if the approval step were ever weakened,
 * the failure should be "they can do nothing" rather than "they can do
 * everything".
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function getDefaultRoleIdForNewUser(organizationId: bigint): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id
      FROM roles
     WHERE organization_id = ${organizationId}
     ORDER BY coalesce(array_length(capabilities, 1), 0) ASC, sort_order DESC
     LIMIT 1
  `;

  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `Organisation ${organizationId} has no roles. Run \`npm run db:seed\`, or create at least one role.`
    );
  }
  return id;
}

/** Just the id, for the common case of stamping it on a new row. */
export async function getCurrentOrganizationId(): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM organizations ORDER BY id ASC LIMIT 1
  `;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("No organisation found. Run `npm run db:seed` before starting the app.");
  }
  return id;
}
