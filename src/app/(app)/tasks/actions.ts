"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireActingUser } from "@/lib/auth/session";
import { createTaskSchema } from "@/lib/tasks/schemas";
import { createTask } from "@/lib/tasks/service";
import { ForbiddenError, InvalidOperationError, NotFoundError } from "@/lib/errors";

/**
 * Server actions for the task screens.
 *
 * These go through exactly the same service functions as the HTTP API — same
 * validation, same permission kernel, same activity log. A server action is
 * just another caller; it gets no shortcut, and there is no "internal" path
 * that skips a check because the request came from our own form.
 */

export interface CreateTaskResult {
  ok: boolean;
  /** Field-level messages, keyed by input name. */
  fieldErrors?: Record<string, string>;
  /** Something that isn't about one field. */
  formError?: string;
  created?: { key: string; title: string };
}

export async function createTaskAction(
  _prev: CreateTaskResult | null,
  formData: FormData
): Promise<CreateTaskResult> {
  const user = await requireActingUser();

  const raw = {
    title: String(formData.get("title") ?? ""),
    engagementId: String(formData.get("engagementId") ?? ""),
    assigneeId: String(formData.get("assigneeId") ?? ""),
    dueDate: String(formData.get("dueDate") ?? ""),
    // Optional fields live behind the "More" disclosure. Empty strings are
    // dropped rather than passed through — an empty <input> should mean
    // "not provided", not "the empty value".
    ...(formData.get("description") ? { description: String(formData.get("description")) } : {}),
    ...(formData.get("priority") ? { priority: String(formData.get("priority")) } : {}),
    ...(formData.get("reviewerId") ? { reviewerId: String(formData.get("reviewerId")) } : {}),
    ...(formData.get("dueDateType") ? { dueDateType: String(formData.get("dueDateType")) } : {}),
    ...(formData.get("estimateHours")
      ? { estimateMinutes: Math.round(Number(formData.get("estimateHours")) * 60) }
      : {}),
  };

  try {
    const input = createTaskSchema.parse(raw);
    const task = await createTask(user, input);

    // The new task belongs on the creator's screens straight away.
    revalidatePath("/tasks");

    return { ok: true, created: { key: task.displayKey, title: task.title } };
  } catch (e) {
    if (e instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of e.issues) {
        const key = String(issue.path[0] ?? "_");
        // First message per field. Stacking three messages under one input
        // reads as shouting and rarely tells the user anything extra.
        fieldErrors[key] ??= issue.message;
      }
      return { ok: false, fieldErrors };
    }

    if (e instanceof ForbiddenError) {
      return { ok: false, formError: "You cannot create work on that engagement." };
    }

    if (e instanceof InvalidOperationError) {
      return { ok: false, formError: e.message };
    }

    if (e instanceof NotFoundError) {
      return { ok: false, formError: "That engagement or person no longer exists." };
    }

    // Log server-side, say nothing useful to the client — same rule as the API.
    console.error("[action] createTask failed:", e);
    return { ok: false, formError: "Something went wrong. The error has been logged." };
  }
}
