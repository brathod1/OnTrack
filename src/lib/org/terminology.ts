import { getCurrentOrganization } from "./current";

/**
 * What this organisation calls things.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The engine's concepts have fixed names in CODE — client, engagement, task,
 * review, externalDeadline. What an organisation SEES is configuration.
 *
 *   CA firm            Client   · Engagement · Statutory deadline · Review
 *   Software company   Customer · Project    · Contractual SLA    · QA
 *   Internal team      —        · Project    · Hard deadline      · Approval
 *
 * DELIBERATELY SMALL. This is a lookup table with sensible fallbacks, not a
 * translation framework: no interpolation, no pluralisation rules, no locale
 * negotiation. Those belong to i18n, which is a different problem from
 * "this organisation says Customer instead of Client", and conflating them
 * produces something nobody can configure.
 *
 * Defaults are the CA firm's vocabulary because that is the first
 * organisation using OnTrack. An organisation that sets nothing gets a
 * product that reads as though it was built for them — which, today, it was.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface TermDefinition {
  singular: string;
  plural: string;
  /** Compact form for badges and narrow columns. Falls back to singular. */
  short?: string;
}

/** Every concept the UI names. Adding one here without a default is a bug. */
export type TermKey =
  | "client"
  | "engagement"
  | "task"
  | "subtask"
  | "team"
  | "review"
  | "externalDeadline"
  | "internalDeadline"
  | "committedDeadline";

export const DEFAULT_TERMS: Record<TermKey, TermDefinition> = {
  client: { singular: "Client", plural: "Clients" },
  engagement: { singular: "Engagement", plural: "Engagements" },
  task: { singular: "Task", plural: "Tasks" },
  subtask: { singular: "Subtask", plural: "Subtasks" },
  team: { singular: "Team", plural: "Teams" },
  review: { singular: "Review", plural: "Reviews" },

  // The three deadline types. The engine knows EXTERNAL_FIXED / COMMITTED /
  // INTERNAL; these are what a person reads.
  externalDeadline: {
    singular: "Statutory deadline",
    plural: "Statutory deadlines",
    short: "Stat",
  },
  committedDeadline: {
    singular: "Client commitment",
    plural: "Client commitments",
    short: "Committed",
  },
  internalDeadline: {
    singular: "Internal target",
    plural: "Internal targets",
    short: "Internal",
  },
};

/** Resolved vocabulary, with a lookup that cannot return undefined. */
export interface Terminology {
  term: (key: TermKey) => TermDefinition;
  /** Shorthand for the common case. */
  t: (key: TermKey) => string;
  plural: (key: TermKey) => string;
  short: (key: TermKey) => string;
}

/**
 * Merge stored overrides over the defaults, one field at a time.
 *
 * An organisation that sets only `client.singular` keeps the default plural
 * rather than losing it — a whole-object replace would leave them with an
 * empty string on screen and no obvious cause.
 */
function resolve(stored: unknown): Record<TermKey, TermDefinition> {
  const overrides = (stored ?? {}) as Partial<Record<TermKey, Partial<TermDefinition>>>;
  const out = {} as Record<TermKey, TermDefinition>;

  for (const key of Object.keys(DEFAULT_TERMS) as TermKey[]) {
    const base = DEFAULT_TERMS[key];
    const over = overrides[key] ?? {};
    out[key] = {
      singular: over.singular?.trim() || base.singular,
      plural: over.plural?.trim() || base.plural,
      short: over.short?.trim() || base.short,
    };
  }

  return out;
}

export function makeTerminology(stored: unknown): Terminology {
  const terms = resolve(stored);
  return {
    term: (key) => terms[key],
    t: (key) => terms[key].singular,
    plural: (key) => terms[key].plural,
    short: (key) => terms[key].short ?? terms[key].singular,
  };
}

/**
 * The organisation's vocabulary, for use in server components.
 *
 * One indexed lookup on a one-row table — the same reasoning as
 * getCurrentOrganization(): a cache here would buy microseconds and cost a
 * class of "the administrator renamed it but only some pages changed" bug.
 */
export async function getTerminology(): Promise<Terminology> {
  const org = await getCurrentOrganization();
  return makeTerminology(org.terminology);
}

/** Maps a DueDateType to the term that names it. */
export function deadlineTermKey(
  type: "EXTERNAL_FIXED" | "COMMITTED" | "INTERNAL"
): TermKey {
  switch (type) {
    case "EXTERNAL_FIXED":
      return "externalDeadline";
    case "COMMITTED":
      return "committedDeadline";
    case "INTERNAL":
      return "internalDeadline";
  }
}
