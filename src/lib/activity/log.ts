import { Prisma, type ActivityAction } from "@prisma/client";

/**
 * Writing to the activity log.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Every entry is written INSIDE the same transaction as the change it
 * describes. If the change rolls back, so does its record; if the log write
 * fails, the change fails with it.
 *
 * The alternative — log afterwards, or fire-and-forget — produces a history
 * with holes in it, and a history with holes is worse than none, because
 * people trust it. In a professional services firm this record is the answer
 * to "who moved that deadline?", months later, possibly in front of a client.
 *
 * These functions take a transaction client, never the global `prisma`, so it
 * is impossible to call one outside a transaction by accident.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type Tx = Prisma.TransactionClient;

export interface ActivityInput {
  taskId?: bigint | null;
  actorId: bigint;
  action: ActivityAction;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
}

/**
 * JSON-safe conversion.
 *
 * BigInt does not survive JSON.stringify, and Prisma's Json column goes
 * through exactly that — an unconverted id throws at runtime, inside a
 * transaction, on a code path nobody tests because it only fires when
 * something changes. Dates become ISO strings so an old value stays readable
 * years later without knowing which column it came from.
 */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((v) => toJson(v) ?? null) as Prisma.InputJsonValue;
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJson(v) ?? null])
    ) as Prisma.InputJsonValue;
  }
  return value as Prisma.InputJsonValue;
}

export async function recordActivity(tx: Tx, entry: ActivityInput): Promise<void> {
  await tx.activityLog.create({
    data: {
      taskId: entry.taskId ?? null,
      actorId: entry.actorId,
      action: entry.action,
      field: entry.field ?? null,
      oldValue: toJson(entry.oldValue),
      newValue: toJson(entry.newValue),
      reason: entry.reason ?? null,
      requestId: entry.requestId ?? null,
      ip: entry.ip ?? null,
    },
  });
}

/** Several entries for one logical change — a PATCH touching three fields. */
export async function recordActivities(tx: Tx, entries: ActivityInput[]): Promise<void> {
  for (const e of entries) await recordActivity(tx, e);
}

/**
 * Changes that must never happen without a stated reason.
 *
 * Enforced in the service layer rather than at the log, because the rule is
 * about the CHANGE, not the record: "you may not move this deadline without
 * saying why". Rejecting it at the log would mean the deadline had already
 * moved.
 */
const REASON_REQUIRED = new Set<ActivityAction>([
  "DUE_DATE_CHANGED",
  "TASK_REOPENED",
  "TASK_CANCELLED",
  "REVIEW_REJECTED",
  "TIME_EDITED",
  "TIME_DELETED",
]);

export function reasonRequired(action: ActivityAction): boolean {
  return REASON_REQUIRED.has(action);
}
