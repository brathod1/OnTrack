import { ActivityAction, NotificationType } from "@prisma/client";
import { notifyMany } from "@/lib/notifications/service";
import { prisma } from "@/lib/db";
import { recordActivity } from "@/lib/activity/log";
import { visibleTaskFilter, canManageTask, type ActingUser } from "@/lib/auth/permissions";
import { ForbiddenError, InvalidOperationError, NotFoundError } from "@/lib/errors";

/**
 * Task discussion.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATELY SMALL. Task discussion in a fifty-person firm is short and
 * operational. Over-building it produces a bad chat application competing
 * with Teams, which the firm already has and already uses.
 *
 * So: flat, chronological, markdown. No threading — at this volume threads
 * fragment the record and make the history harder to read, which is the
 * opposite of what a work record is for.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * How long an author may edit their own comment.
 *
 * Long enough to fix a typo or finish a sentence; short enough that the
 * record cannot be quietly rewritten after someone has acted on it. A comment
 * is part of the work history, not a draft.
 */
export const EDIT_WINDOW_MINUTES = 15;

/** Confirms the caller may see the task, and returns its id. */
async function assertCanSeeTask(user: ActingUser, taskId: bigint): Promise<void> {
  const found = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, visibleTaskFilter(user)] },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Task");
}

/**
 * People this task's watchers can mention.
 *
 * Restricted to those with an actual relationship to the task. Offering the
 * whole firm would let a mention notify someone who then cannot open the task
 * they were summoned to — an invitation to a room they have no key for.
 */
export async function getMentionableUsers(user: ActingUser, taskId: bigint) {
  await assertCanSeeTask(user, taskId);

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      assigneeId: true,
      reviewerId: true,
      createdById: true,
      engagementId: true,
      contributors: { select: { userId: true } },
    },
  });

  const members = await prisma.engagementMember.findMany({
    where: {
      engagementId: task.engagementId,
      OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
    },
    select: { userId: true },
  });

  const ids = new Set<bigint>([
    task.assigneeId,
    task.createdById,
    ...(task.reviewerId ? [task.reviewerId] : []),
    ...task.contributors.map((c) => c.userId),
    ...members.map((m) => m.userId),
  ]);

  return prisma.user.findMany({
    where: { id: { in: [...ids] }, status: "ACTIVE" },
    select: { id: true, name: true, grade: true },
    orderBy: { name: "asc" },
  });
}

export async function listComments(user: ActingUser, taskId: bigint) {
  await assertCanSeeTask(user, taskId);

  return prisma.comment.findMany({
    where: { taskId },
    select: {
      id: true,
      bodyMd: true,
      mentions: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
      author: { select: { id: true, name: true } },
    },
    // Oldest first: a discussion reads as a conversation, unlike the activity
    // timeline where the recent change is what people arrive looking for.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function addComment(
  user: ActingUser,
  taskId: bigint,
  input: { bodyMd: string; mentions?: bigint[] }
) {
  await assertCanSeeTask(user, taskId);

  const body = input.bodyMd.trim();
  if (!body) throw new InvalidOperationError("A comment cannot be empty.");

  // Mentions are validated against people who can actually see this task.
  // A client could otherwise post any id and notify someone about work they
  // are not permitted to open.
  let mentions: bigint[] = [];
  if (input.mentions?.length) {
    const allowed = await getMentionableUsers(user, taskId);
    const allowedIds = new Set(allowed.map((u) => u.id));
    mentions = input.mentions.filter((id) => allowedIds.has(id));
  }

  return prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: { taskId, authorId: user.id, bodyMd: body, mentions },
      select: {
        id: true, bodyMd: true, mentions: true, createdAt: true,
        editedAt: true, deletedAt: true,
        author: { select: { id: true, name: true } },
      },
    });

    await recordActivity(tx, {
      taskId,
      actorId: user.id,
      action: ActivityAction.COMMENT_ADDED,
    });

    // Only the people MENTIONED, never everyone who can see the task. A
    // mention is one person addressing another; a comment is not an
    // announcement, and treating it as one is how a team learns to ignore the
    // bell. The list was already filtered above to people who can open the
    // task, so this cannot invite anyone into a room they have no key to.
    await notifyMany(tx, mentions, {
      actorId: user.id,
      type: NotificationType.MENTIONED,
      taskId,
      payload: {
        // An excerpt, so the list is readable without opening every task.
        // Truncated rather than stored whole: this is a pointer to the
        // conversation, not a copy of it.
        excerpt: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      },
    });

    return comment;
  });
}

export async function editComment(user: ActingUser, commentId: bigint, bodyMd: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, taskId: true, authorId: true, createdAt: true, deletedAt: true, bodyMd: true },
  });
  if (!comment) throw new NotFoundError("Comment");
  await assertCanSeeTask(user, comment.taskId);

  if (comment.deletedAt) throw new InvalidOperationError("That comment has been removed.");

  // Only the author. A manager editing someone else's words would make the
  // record untrustworthy in exactly the situation it exists for.
  if (comment.authorId !== user.id) {
    throw new ForbiddenError("edit someone else's comment");
  }

  const ageMinutes = (Date.now() - comment.createdAt.getTime()) / 60_000;
  if (ageMinutes > EDIT_WINDOW_MINUTES) {
    throw new InvalidOperationError(
      `Comments can only be edited within ${EDIT_WINDOW_MINUTES} minutes. Add a new comment instead.`
    );
  }

  const body = bodyMd.trim();
  if (!body) throw new InvalidOperationError("A comment cannot be empty.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.comment.update({
      where: { id: commentId },
      data: { bodyMd: body, editedAt: new Date() },
      select: {
        id: true, bodyMd: true, mentions: true, createdAt: true,
        editedAt: true, deletedAt: true,
        author: { select: { id: true, name: true } },
      },
    });

    await recordActivity(tx, {
      taskId: comment.taskId,
      actorId: user.id,
      action: ActivityAction.COMMENT_EDITED,
      // The original text is kept in the log, so an edit cannot erase what
      // was said — only supersede it.
      oldValue: comment.bodyMd,
      newValue: body,
    });

    return updated;
  });
}

/**
 * Soft delete, leaving a tombstone.
 *
 * The row stays; the page renders "Comment removed". A comment vanishing
 * without trace from a work record is not acceptable in a firm where that
 * record may be read back months later — and the database refuses a hard
 * delete anyway, since the application role has no DELETE on comments.
 */
export async function deleteComment(user: ActingUser, commentId: bigint, reason?: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true, taskId: true, authorId: true, deletedAt: true, bodyMd: true,
      task: {
        select: {
          assigneeId: true, createdById: true, assignedById: true, reviewerId: true,
          engagementId: true, status: true,
          engagement: { select: { partnerId: true, managerId: true } },
          contributors: { select: { userId: true } },
        },
      },
    },
  });
  if (!comment) throw new NotFoundError("Comment");
  await assertCanSeeTask(user, comment.taskId);

  if (comment.deletedAt) return comment;

  const isAuthor = comment.authorId === user.id;
  const manages = canManageTask(user, {
    assigneeId: comment.task.assigneeId,
    createdById: comment.task.createdById,
    assignedById: comment.task.assignedById,
    reviewerId: comment.task.reviewerId,
    engagementId: comment.task.engagementId,
    status: comment.task.status,
    isContributor: comment.task.contributors.some((c) => c.userId === user.id),
    engagementPartnerId: comment.task.engagement.partnerId,
    engagementManagerId: comment.task.engagement.managerId,
  });

  if (!isAuthor && !manages) {
    throw new ForbiddenError("remove this comment");
  }

  return prisma.$transaction(async (tx) => {
    const removed = await tx.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date(), deletedById: user.id },
      select: {
        id: true, bodyMd: true, mentions: true, createdAt: true,
        editedAt: true, deletedAt: true,
        author: { select: { id: true, name: true } },
      },
    });

    await recordActivity(tx, {
      taskId: comment.taskId,
      actorId: user.id,
      action: ActivityAction.COMMENT_DELETED,
      oldValue: comment.bodyMd,
      reason: reason ?? null,
    });

    return removed;
  });
}

/** Whether this comment is still inside its author's edit window. */
export function isEditable(
  comment: { authorId?: bigint; createdAt: Date; deletedAt: Date | null },
  authorId: bigint,
  userId: bigint,
  now = new Date()
): boolean {
  if (comment.deletedAt) return false;
  if (authorId !== userId) return false;
  return (now.getTime() - comment.createdAt.getTime()) / 60_000 <= EDIT_WINDOW_MINUTES;
}
