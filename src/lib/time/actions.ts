"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireActingUser } from "@/lib/auth/session";
import {
  ConflictError,
  ForbiddenError,
  InvalidOperationError,
  NotFoundError,
} from "@/lib/errors";
import {
  deleteTimeSchema,
  discardTimerSchema,
  editTimeSchema,
  logTimeSchema,
  startTimerSchema,
  stopTimerSchema,
} from "./schemas";
import {
  deleteTimeEntry,
  discardTimer,
  editTimeEntry,
  logManualTime,
  startTimer,
  stopTimer,
} from "./service";

/**
 * Server actions for time tracking.
 *
 * Thin, like the task actions: parse, delegate, translate. Every rule about
 * who may log what, and every guardrail, lives in the service.
 *
 * Each action revalidates BOTH the task page and the places a total is shown,
 * because logging time changes a number in three separate views at once. A
 * timesheet that disagrees with the task it was entered from is the fastest
 * way to lose a user's trust in the figures.
 */

export interface TimeActionResult {
  ok: boolean;
  error?: string;
  /** Starting a timer stopped another. Said plainly rather than silently. */
  stoppedOther?: { taskKey: string; taskTitle: string; minutes: number };
  /** The service wants a note before it will accept this. */
  needsNote?: boolean;
}

function translate(e: unknown): TimeActionResult {
  if (e instanceof ForbiddenError) {
    return { ok: false, error: "You are not permitted to do that." };
  }
  if (e instanceof NotFoundError) {
    return { ok: false, error: "That no longer exists." };
  }
  if (e instanceof ConflictError) {
    return { ok: false, error: "Someone else changed this while you were looking at it." };
  }
  if (e instanceof InvalidOperationError) {
    // Written for a person by the service, so passed straight through.
    return { ok: false, error: e.message, needsNote: /note/i.test(e.message) };
  }
  if (e instanceof ZodError) {
    return { ok: false, error: e.issues[0]?.message ?? "Check the details and try again." };
  }

  console.error("[action] time action failed:", e);
  return { ok: false, error: "Something went wrong. The error has been logged." };
}

/** Everywhere a time total is rendered. */
function revalidateTimeViews(taskKey?: string) {
  if (taskKey) revalidatePath(`/tasks/${taskKey}`);
  revalidatePath("/tasks");
  revalidatePath("/my-work");
  revalidatePath("/timesheet");
}

export async function startTimerAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const { taskId } = startTimerSchema.parse({
      taskId: String(formData.get("taskId") ?? ""),
    });

    const { stopped } = await startTimer(user, taskId);

    revalidateTimeViews(key);
    return { ok: true, stoppedOther: stopped };
  } catch (e) {
    return translate(e);
  }
}

export async function stopTimerAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const input = stopTimerSchema.parse({
      note: formData.get("note") ? String(formData.get("note")) : undefined,
      expectedTaskId: formData.get("taskId") ? String(formData.get("taskId")) : undefined,
    });

    await stopTimer(user, input);

    revalidateTimeViews(key);
    return { ok: true };
  } catch (e) {
    return translate(e);
  }
}

export async function discardTimerAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const { reason, expectedTaskId } = discardTimerSchema.parse({
      reason: String(formData.get("reason") ?? ""),
      expectedTaskId: formData.get("taskId") ? String(formData.get("taskId")) : undefined,
    });

    await discardTimer(user, reason, expectedTaskId);

    revalidateTimeViews(key);
    return { ok: true };
  } catch (e) {
    return translate(e);
  }
}

export async function logTimeAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const input = logTimeSchema.parse({
      taskId: String(formData.get("taskId") ?? ""),
      workDate: String(formData.get("workDate") ?? ""),
      duration: String(formData.get("duration") ?? ""),
      note: formData.get("note") ? String(formData.get("note")) : undefined,
    });

    await logManualTime(user, {
      taskId: input.taskId,
      workDate: input.workDate,
      minutes: input.duration,
      note: input.note,
    });

    revalidateTimeViews(key);
    return { ok: true };
  } catch (e) {
    return translate(e);
  }
}

export async function editTimeAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const input = editTimeSchema.parse({
      entryId: String(formData.get("entryId") ?? ""),
      duration: String(formData.get("duration") ?? ""),
      note: formData.get("note") ? String(formData.get("note")) : undefined,
      reason: formData.get("reason") ? String(formData.get("reason")) : undefined,
    });

    await editTimeEntry(user, input.entryId, {
      minutes: input.duration,
      note: input.note,
      reason: input.reason,
    });

    revalidateTimeViews(key);
    return { ok: true };
  } catch (e) {
    return translate(e);
  }
}

export async function deleteTimeAction(
  _prev: TimeActionResult | null,
  formData: FormData
): Promise<TimeActionResult> {
  const user = await requireActingUser();
  const key = formData.get("key") ? String(formData.get("key")) : undefined;

  try {
    const input = deleteTimeSchema.parse({
      entryId: String(formData.get("entryId") ?? ""),
      reason: formData.get("reason") ? String(formData.get("reason")) : undefined,
    });

    await deleteTimeEntry(user, input.entryId, input.reason);

    revalidateTimeViews(key);
    return { ok: true };
  } catch (e) {
    return translate(e);
  }
}
