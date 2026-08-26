import { jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { transitionSchema } from "@/lib/tasks/schemas";
import { resolveTaskIdByKey, transitionTask } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tasks/TSK-2026-00127/transition
 *
 * The ONLY way a task's status changes. There is deliberately no
 * `PATCH { status }` — routing every change through the state machine is what
 * guarantees the guards, the reason requirement and the activity record
 * cannot be skipped by choosing a different endpoint.
 */

type Ctx = { params: Promise<{ key: string }> };

export const POST = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const input = transitionSchema.parse(await jsonBody(request));

  const { task, warnings } = await transitionTask(user, taskId, input);

  return ok({
    id: task.id,
    key: task.displayKey,
    status: task.status,
    reviewRound: task.reviewRound,
    reopenCount: task.reopenCount,
    completedAt: task.completedAt,
    version: task.updatedAt,

    /**
     * Soft warnings: the change succeeded, but something is worth saying.
     * "Completed with no time logged" is the main one — blocking it would
     * teach people to log a fake fifteen minutes, which is worse than the
     * gap it was meant to prevent.
     */
    warnings,
  });
});
