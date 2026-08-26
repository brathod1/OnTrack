import { jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { updateTaskSchema } from "@/lib/tasks/schemas";
import { getTaskByKey, resolveTaskIdByKey, updateTask } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET   /api/v1/tasks/TSK-2026-00127
 * PATCH /api/v1/tasks/TSK-2026-00127
 *
 * A task the caller may not see returns 404, identical to one that does not
 * exist. There is no code path here that returns 403 for a read.
 */

type Ctx = { params: Promise<{ key: string }> };

export const GET = route<Ctx>(async (user, _request, { params }) => {
  const { key } = await params;
  const { task, transitions, canManage } = await getTaskByKey(user, key);

  return ok({
    id: task.id,
    key: task.displayKey,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,

    isBlocked: task.isBlocked,
    blockedReason: task.blockedReason,
    blockedSince: task.blockedSince,
    expectedUnblockDate: task.expectedUnblockDate,

    dueDate: task.dueDate,
    dueDateType: task.dueDateType,
    externalDeadline: task.externalDeadline,

    originalEstimateMinutes: task.originalEstimateMinutes,
    currentEstimateMinutes: task.currentEstimateMinutes,
    actualMinutes: task.actualMinutes,

    assigneeId: task.assigneeId,
    assignedById: task.assignedById,
    createdById: task.createdById,
    reviewerId: task.reviewerId,
    reviewRequired: task.reviewRequired,
    reviewRound: task.reviewRound,
    reopenCount: task.reopenCount,

    parentTaskId: task.parentTaskId,
    openSubtasks: task._count.subtasks,
    contributors: task.contributors.map((c) => c.userId),

    engagement: {
      id: task.engagement.id,
      client: task.engagement.client,
    },

    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    cancelReason: task.cancelReason,

    /**
     * What the caller may do, computed server-side.
     *
     * The UI renders buttons from this rather than deciding for itself. That
     * keeps one source of truth — and because every mutation re-checks
     * anyway, a client that ignores this list gains nothing.
     */
    permissions: {
      canManage,
      transitions: transitions.map((t) => ({
        to: t.to,
        label: t.label,
        requiresReason: t.requiresReason,
      })),
    },

    /** Pass this back as expectedVersion on any write. */
    version: task.updatedAt,
  });
});

export const PATCH = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const input = updateTaskSchema.parse(await jsonBody(request));

  const task = await updateTask(user, taskId, input);

  return ok({
    id: task.id,
    key: task.displayKey,
    title: task.title,
    status: task.status,
    dueDate: task.dueDate,
    priority: task.priority,
    version: task.updatedAt,
  });
});
