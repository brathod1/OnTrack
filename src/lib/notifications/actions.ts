"use server";

import { revalidatePath } from "next/cache";
import { requireActingUser } from "@/lib/auth/session";
import { getCurrentOrganization } from "@/lib/org/current";
import { describeNotification, shortAgo } from "./describe";
import { listNotifications, markAllRead, markRead, markTaskRead } from "./service";
import type { NotificationRow } from "./types";

/**
 * Server actions for notifications.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ALL THREE ARE MUTATIONS, AND THAT IS WHY THEY ARE ACTIONS RATHER THAN
 * SOMETHING THE PAGE DOES WHILE RENDERING.
 *
 * The obvious shortcut — call markTaskRead() inside the task page component —
 * is a trap. Next.js prefetches links on hover, so merely moving the mouse
 * down a task list would render those pages on the server and silently mark
 * their notifications read. The user would watch their unread count fall
 * without opening anything.
 *
 * A mutation belongs behind an explicit action, triggered by something that
 * only happens when a person is genuinely there.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * The rows for the header panel.
 *
 * Fetched when the panel is OPENED, not rendered into every page. The bell
 * needs one number; loading a list on every request to a page that may never
 * be opened is work done for nothing, on every navigation, for every user.
 */
export async function getNotificationsAction(
  limit = 8
): Promise<NotificationRow[]> {
  const user = await requireActingUser();
  const [notifications, org] = await Promise.all([
    listNotifications(user, { limit }),
    getCurrentOrganization(),
  ]);

  return notifications.map((n) => {
    const described = describeNotification(n, org.dateFormat);
    return {
      id: n.id.toString(),
      taskKey: n.task?.displayKey ?? null,
      taskTitle: n.task?.title ?? null,
      clientName: n.task?.engagement.client.name ?? null,
      headline: described.headline,
      detail: described.detail,
      tone: described.tone,
      ago: shortAgo(n.createdAt),
      read: n.readAt !== null,
    };
  });
}

export async function markReadAction(ids: string[]): Promise<{ ok: boolean }> {
  const user = await requireActingUser();

  const parsed = ids.filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id));
  if (parsed.length === 0) return { ok: true };

  // The service scopes by userId in the WHERE clause, so an id belonging to
  // someone else updates nothing rather than being refused.
  await markRead(user, parsed);

  revalidatePath("/notifications");
  revalidatePath("/tasks");
  return { ok: true };
}

export async function markAllReadAction(): Promise<{ ok: boolean; count: number }> {
  const user = await requireActingUser();
  const count = await markAllRead(user);

  revalidatePath("/notifications");
  revalidatePath("/tasks");
  return { ok: true, count };
}

/** Called from the task page once it is genuinely on screen. */
export async function markTaskReadAction(taskId: string): Promise<{ ok: boolean }> {
  const user = await requireActingUser();
  if (!/^\d+$/.test(taskId)) return { ok: false };

  const count = await markTaskRead(user, BigInt(taskId));

  // Only revalidate when something actually changed. Opening a task you have
  // no notifications for is the common case, and re-rendering the shell every
  // time would be work done for nothing.
  if (count > 0) {
    revalidatePath("/notifications");
    revalidatePath("/tasks");
  }

  return { ok: true };
}
