import { jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { contributorSchema } from "@/lib/tasks/schemas";
import { addContributor, removeContributor, resolveTaskIdByKey } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST   /api/v1/tasks/TSK-2026-00127/contributors   { userId }
 * DELETE /api/v1/tasks/TSK-2026-00127/contributors   { userId }
 *
 * One accountable owner plus contributors. A contributor may log time and
 * comment; they may not change status, dates, priority or the assignee. That
 * preserves a single answer to "who is responsible?" while still capturing the
 * real effort — including a reviewer's, which is otherwise invisible.
 *
 * DELETE carries a body, which is unusual but correct here: the resource being
 * removed is identified by the pair (task, user), and putting the user id in
 * the path would imply a sub-resource URL that nothing else uses.
 */

type Ctx = { params: Promise<{ key: string }> };

export const POST = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const { userId } = contributorSchema.parse(await jsonBody(request));

  const task = await addContributor(user, taskId, userId);

  return ok({
    id: task.id,
    key: task.displayKey,
    contributors: task.contributors.map((c) => c.userId),
  });
});

export const DELETE = route<Ctx>(async (user, request, { params }) => {
  const { key } = await params;
  const taskId = await resolveTaskIdByKey(user, key);
  const { userId } = contributorSchema.parse(await jsonBody(request));

  const task = await removeContributor(user, taskId, userId);

  return ok({
    id: task.id,
    key: task.displayKey,
    contributors: task.contributors.map((c) => c.userId),
  });
});
