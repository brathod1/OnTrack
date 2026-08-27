import type { Metadata } from "next";
import { requireActingUser } from "@/lib/auth/session";
import { getCurrentOrganization } from "@/lib/org/current";
import { listNotifications } from "@/lib/notifications/service";
import { describeNotification, shortAgo } from "@/lib/notifications/describe";
import { NotificationList } from "@/components/notification-list";

export const metadata: Metadata = { title: "Notifications · OnTrack" };

export default async function NotificationsPage() {
  const actor = await requireActingUser();
  const [notifications, org] = await Promise.all([
    listNotifications(actor, { limit: 100 }),
    getCurrentOrganization(),
  ]);

  const rows = notifications.map((n) => {
    // Dates written the firm's way, not the server's.
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

  return (
    <main>
      <h1 className="text-xl font-semibold text-slate-900">Notifications</h1>
      <NotificationList rows={rows} />
    </main>
  );
}
