"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireActingUser } from "@/lib/auth/session";
import { blockSchema, transitionSchema } from "@/lib/tasks/schemas";
import {
  addContributor,
  removeContributor,
  resolveTaskIdByKey,
  setBlocked,
  transitionTask,
} from "@/lib/tasks/service";
import { addComment, deleteComment, editComment } from "@/lib/tasks/comments";
import {
  ConflictError,
  ForbiddenError,
  InvalidOperationError,
  NotFoundError,
} from "@/lib/errors";

/**
 * Server actions for the task detail page.
 *
 * Thin. They resolve the key, hand the input to the same service the HTTP API
 * uses, and translate the outcome for a form. Every guard, every reason
 * requirement and every activity entry lives in the service — a second
 * implementation here is how the two paths drift apart and one of them
 * quietly stops enforcing something.
 */

export interface ActionResult {
  ok: boolean;
  /** Shown to the user. Written for a person, not a log. */
  error?: string;
  /** Succeeded, but something is worth saying. */
  warnings?: string[];
  /**
   * The write was refused because someone else changed the task first. The UI
   * offers a reload rather than retrying: retrying silently would apply the
   * change to a task that may no longer be the one the user was looking at.
   */
  conflict?: boolean;
  /**
   * The transition was blocked by open subtasks and this user could override
   * it. The UI offers the choice; it never overrides on the user's behalf.
   */
  canOverride?: boolean;
}

function translate(e: unknown, canOverrideHint: boolean): ActionResult {
  if (e instanceof ConflictError) {
    return {
      ok: false,
      conflict: true,
      error: "Someone else changed this task while you were looking at it.",
    };
  }
  if (e instanceof ForbiddenError) {
    return { ok: false, error: "You are not permitted to do that." };
  }
  if (e instanceof NotFoundError) {
    return { ok: false, error: "That task no longer exists." };
  }
  if (e instanceof InvalidOperationError) {
    // The service writes these for a person to read, so pass them through.
    const subtaskBlocked = /subtask/i.test(e.message);
    return {
      ok: false,
      error: e.message,
      canOverride: subtaskBlocked && canOverrideHint,
    };
  }
  if (e instanceof ZodError) {
    return { ok: false, error: e.issues[0]?.message ?? "Check the details and try again." };
  }

  console.error("[action] task action failed:", e);
  return { ok: false, error: "Something went wrong. The error has been logged." };
}

export async function transitionAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const taskId = await resolveTaskIdByKey(user, key);
    const input = transitionSchema.parse({
      expectedVersion: String(formData.get("expectedVersion") ?? ""),
      to: String(formData.get("to") ?? ""),
      reason: formData.get("reason") ? String(formData.get("reason")) : undefined,
      override: formData.get("override") === "on",
    });

    const { warnings } = await transitionTask(user, taskId, input);

    revalidatePath(`/tasks/${key}`);
    revalidatePath("/tasks");

    return { ok: true, warnings };
  } catch (e) {
    // Whether an override is even offered is the kernel's call, not the form's.
    return translate(e, formData.get("canManage") === "true");
  }
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function addCommentAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const taskId = await resolveTaskIdByKey(user, key);
    const body = String(formData.get("body") ?? "");

    // Mentions arrive as ids the picker collected, never parsed from the text.
    // Parsing "@Kavya" breaks the moment two people share a first name, and
    // resolves silently to the wrong person rather than failing.
    const mentions = String(formData.get("mentions") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => BigInt(s));

    await addComment(user, taskId, { bodyMd: body, mentions });

    revalidatePath(`/tasks/${key}`);
    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}

export async function editCommentAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const commentId = BigInt(String(formData.get("commentId") ?? "0"));
    await editComment(user, commentId, String(formData.get("body") ?? ""));

    revalidatePath(`/tasks/${key}`);
    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}

export async function deleteCommentAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const commentId = BigInt(String(formData.get("commentId") ?? "0"));
    await deleteComment(user, commentId);

    revalidatePath(`/tasks/${key}`);
    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}

// ── Contributors ────────────────────────────────────────────────────────────

export async function addContributorAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const taskId = await resolveTaskIdByKey(user, key);
    const userId = BigInt(String(formData.get("userId") ?? "0"));
    await addContributor(user, taskId, userId);

    revalidatePath(`/tasks/${key}`);
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}

export async function removeContributorAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const taskId = await resolveTaskIdByKey(user, key);
    const userId = BigInt(String(formData.get("userId") ?? "0"));
    await removeContributor(user, taskId, userId);

    revalidatePath(`/tasks/${key}`);
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}

export async function setBlockedAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const user = await requireActingUser();
  const key = String(formData.get("key") ?? "");

  try {
    const taskId = await resolveTaskIdByKey(user, key);
    const blocked = formData.get("blocked") === "true";

    const input = blockSchema.parse({
      expectedVersion: String(formData.get("expectedVersion") ?? ""),
      blocked,
      reason: formData.get("reason") ? String(formData.get("reason")) : undefined,
      expectedUnblockDate: formData.get("expectedUnblockDate")
        ? String(formData.get("expectedUnblockDate"))
        : undefined,
    });

    await setBlocked(user, taskId, input);

    revalidatePath(`/tasks/${key}`);
    revalidatePath("/tasks");

    return { ok: true };
  } catch (e) {
    return translate(e, false);
  }
}
