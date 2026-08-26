import { created, jsonBody, ok } from "@/lib/api/respond";
import { route } from "@/lib/api/route";
import { createTaskSchema, listTasksSchema } from "@/lib/tasks/schemas";
import { createTask, listTasks } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/tasks   — list, scoped and filtered
 * POST /api/v1/tasks   — create
 *
 * Note how little is here. Authentication comes from `route()`, authorisation
 * from the service via the permission kernel, validation from Zod, error
 * translation from `mapError`. If a route handler ever starts containing an
 * `if (user.role === ...)`, the kernel has been bypassed.
 */

/** Query strings are all strings; coerce to the shapes the schema expects. */
function parseListQuery(url: URL) {
  const q = url.searchParams;
  const many = (key: string) => {
    const v = q.getAll(key).flatMap((s) => s.split(","));
    return v.length ? v : undefined;
  };
  const bool = (key: string) => {
    const v = q.get(key);
    return v === null ? undefined : v === "true" || v === "1";
  };

  return listTasksSchema.parse({
    clientId: q.get("clientId") ?? undefined,
    engagementId: q.get("engagementId") ?? undefined,
    assigneeId: q.get("assigneeId") ?? undefined,
    assignedById: q.get("assignedById") ?? undefined,
    reviewerId: q.get("reviewerId") ?? undefined,
    status: many("status"),
    priority: many("priority"),
    dueDateType: many("dueDateType"),
    tagIds: many("tagIds"),
    blocked: bool("blocked"),
    overdue: bool("overdue"),
    hasEstimate: bool("hasEstimate"),
    dueBefore: q.get("dueBefore") ?? undefined,
    dueAfter: q.get("dueAfter") ?? undefined,
    search: q.get("search") ?? undefined,
    cursor: q.get("cursor") ?? undefined,
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
  });
}

export const GET = route(async (user, request) => {
  const filters = parseListQuery(new URL(request.url));
  const { tasks, nextCursor } = await listTasks(user, filters);

  return ok({
    tasks: tasks.map((t) => ({
      id: t.id,
      key: t.displayKey,
      title: t.title,
      status: t.status,
      priority: t.priority,
      isBlocked: t.isBlocked,
      blockedReason: t.blockedReason,
      dueDate: t.dueDate,
      dueDateType: t.dueDateType,
      assigneeId: t.assigneeId,
      reviewerId: t.reviewerId,
      estimateMinutes: t.currentEstimateMinutes,
      actualMinutes: t.actualMinutes,
      openSubtasks: t._count.subtasks,
      client: t.engagement.client,
      version: t.updatedAt,
    })),
    nextCursor,
  });
});

export const POST = route(async (user, request) => {
  const input = createTaskSchema.parse(await jsonBody(request));
  const task = await createTask(user, input);

  return created({
    id: task.id,
    key: task.displayKey,
    title: task.title,
    status: task.status,
    version: task.updatedAt,
  });
});
