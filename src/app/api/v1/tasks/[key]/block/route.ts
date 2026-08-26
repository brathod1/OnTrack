import { jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { blockSchema } from "@/lib/tasks/schemas";
import { resolveTaskIdByKey, setBlocked } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tasks/TSK-2026-00127/block
 *
 * Sets or clears the blocked FLAG. It is not a status, so a blocked task keeps
 * its real workflow position — a task blocked while In Review returns to In
 * Review, not to some ambiguous "was blocked" state.
 *
 * A reason is mandatory. "Blocked" with no reason is noise nobody can act on,
 * and the manager view that matters — work stalled more than N days, and who
 * is holding it up — is only useful if the second half is populated.
 */

type Ctx = { params: Promise<{ key: string }> };

export const POST = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const input = blockSchema.parse(await jsonBody(request));

  const task = await setBlocked(user, taskId, input);

  return ok({
    id: task.id,
    key: task.displayKey,
    status: task.status,
    isBlocked: task.isBlocked,
    blockedReason: task.blockedReason,
    blockedSince: task.blockedSince,
    expectedUnblockDate: task.expectedUnblockDate,
    version: task.updatedAt,
  });
});
