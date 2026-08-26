import { jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { assignTaskSchema } from "@/lib/tasks/schemas";
import { assignTask, resolveTaskIdByKey } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tasks/TSK-2026-00127/assign
 *
 * Its own endpoint rather than a field on PATCH, because reassignment is not
 * a field edit — it stops the previous assignee's running timer, adds the new
 * assignee to the engagement, and records a distinct activity event. Bundling
 * that into a generic update would hide three side effects behind a field
 * name.
 */

type Ctx = { params: Promise<{ key: string }> };

export const POST = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const input = assignTaskSchema.parse(await jsonBody(request));

  const task = await assignTask(user, taskId, input);

  return ok({
    id: task.id,
    key: task.displayKey,
    assigneeId: task.assigneeId,
    assignedById: task.assignedById,
    assignedAt: task.assignedAt,
    version: task.updatedAt,
  });
});
