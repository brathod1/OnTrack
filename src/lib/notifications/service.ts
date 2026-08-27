import { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ActingUser } from "@/lib/auth/permissions";

/**
 * Notifications.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WRITTEN IN THE SAME TRANSACTION AS THE CHANGE THAT CAUSED THEM.
 *
 * `notify()` takes a transaction client and nothing else, exactly like
 * `recordActivity`. A queue here would be worse than useless: if the process
 * dies between committing the assignment and enqueuing the notification, the
 * task is assigned and nobody is told — which is precisely the failure this
 * feature exists to prevent. Atomicity is the guarantee; delivery speed is not
 * the problem being solved.
 *
 * (Email is different, and is where a queue will earn its place: an external
 * service that fails, rate-limits and needs retrying. `emailSentAt` on the row
 * is the seam for that, deliberately left null for now.)
 *
 * TWO RULES DECIDE WHETHER A NOTIFICATION EXISTS AT ALL:
 *
 *   1. NEVER NOTIFY SOMEONE ABOUT THEIR OWN ACTION. The commonest failure of
 *      the genre, and the fastest way to teach people the bell is noise.
 *
 *   2. STANDING, NOT VISIBILITY. Plenty of people can SEE a task; almost none
 *      of them need telling when it changes. A notification goes only to
 *      someone this specific event is addressed to — the new assignee, the
 *      reviewer being asked, the person sent work back, the person mentioned.
 *      Notifying everyone who can see it is how an inbox becomes wallpaper.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Minutes within which repeat events of the same kind fold into one row. */
const COALESCE_WINDOW_MINUTES = 15;

/**
 * Which types collapse, and which must not.
 *
 * A manager adjusting a deadline three times should produce one line, not
 * three. But every mention is a person talking to you and every rejection is a
 * separate judgement — collapsing those loses something the reader needed.
 */
const COALESCES: Record<NotificationType, boolean> = {
  ASSIGNED_TO_ME: false,
  REVIEW_REQUESTED: true,
  REVIEW_REJECTED: false,
  DUE_DATE_CHANGED: true,
  MENTIONED: false,
  ADDED_AS_CONTRIBUTOR: false,
};

export interface NotifyInput {
  /** Who is being told. */
  userId: bigint;
  /** Who caused it. Used to suppress self-notification. */
  actorId: bigint;
  type: NotificationType;
  taskId?: bigint;
  /** Event specifics only — never a copy of the task, which would go stale. */
  payload?: Prisma.InputJsonValue;
}

export async function notify(
  tx: Prisma.TransactionClient,
  input: NotifyInput
): Promise<void> {
  // Rule 1. Silent, not an error: callers legitimately notify a list of people
  // that happens to include the actor, and making each one filter first would
  // mean six places to forget.
  if (input.userId === input.actorId) return;

  const key = input.taskId
    ? `${input.userId}:${input.taskId}:${input.type}`
    : null;

  if (key && COALESCES[input.type]) {
    const since = new Date(Date.now() - COALESCE_WINDOW_MINUTES * 60_000);

    const existing = await tx.notification.findFirst({
      // Only UNREAD ones fold. Once someone has read a notification, a new
      // event is genuinely new and must not be hidden by quietly mutating a
      // row they have already looked at.
      where: { coalesceKey: key, readAt: null, createdAt: { gte: since } },
      select: { id: true },
    });

    if (existing) {
      await tx.notification.update({
        where: { id: existing.id },
        data: {
          payload: input.payload ?? {},
          // Bumped so the item rises to the top: the latest change is the one
          // worth looking at, and leaving it buried would defeat the point.
          createdAt: new Date(),
        },
      });
      return;
    }
  }

  await tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      taskId: input.taskId ?? null,
      payload: input.payload ?? {},
      coalesceKey: key,
    },
  });
}

/**
 * Notify several people, skipping the actor and any duplicates.
 *
 * One person can hold two roles on a task — reviewer and engagement manager,
 * say — and would otherwise be told twice about one event.
 */
export async function notifyMany(
  tx: Prisma.TransactionClient,
  userIds: (bigint | null | undefined)[],
  input: Omit<NotifyInput, "userId">
): Promise<void> {
  const seen = new Set<string>();

  for (const id of userIds) {
    if (!id) continue;
    const k = id.toString();
    if (seen.has(k)) continue;
    seen.add(k);

    await notify(tx, { ...input, userId: id });
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  type: true,
  taskId: true,
  payload: true,
  readAt: true,
  createdAt: true,
  task: {
    select: {
      displayKey: true,
      title: true,
      engagement: { select: { name: true, client: { select: { name: true } } } },
    },
  },
} satisfies Prisma.NotificationSelect;

export type NotificationView = Prisma.NotificationGetPayload<{
  select: typeof listSelect;
}>;

export async function listNotifications(
  user: ActingUser,
  options: { unreadOnly?: boolean; limit?: number } = {}
): Promise<NotificationView[]> {
  return prisma.notification.findMany({
    // Scoped by userId alone, deliberately. A notification row IS the
    // permission — it was created for this person because they had standing at
    // the time. Re-deriving visibility here would mean an event could vanish
    // from your list because you were later removed from an engagement, and
    // "I was told and now there's no record" is worse than a stale line.
    where: {
      userId: user.id,
      ...(options.unreadOnly ? { readAt: null } : {}),
    },
    select: listSelect,
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
  });
}

export async function countUnread(userId: bigint): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(user: ActingUser, ids: bigint[]): Promise<number> {
  if (ids.length === 0) return 0;

  const result = await prisma.notification.updateMany({
    // userId in the WHERE, not a lookup-then-check: a caller passing someone
    // else's notification id updates nothing rather than being refused, and
    // there is no window between the two statements.
    where: { id: { in: ids }, userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });

  return result.count;
}

export async function markAllRead(user: ActingUser): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

/**
 * Mark everything about one task as read.
 *
 * Called when the task is opened. Someone who has just read the task does not
 * then need a bell telling them about it — leaving it unread would train them
 * to ignore the count, which costs more than the occasional missed line.
 */
export async function markTaskRead(user: ActingUser, taskId: bigint): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId: user.id, taskId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
