import { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { visibleTaskFilter, type ActingUser } from "@/lib/auth/permissions";
import { getCurrentOrganization } from "@/lib/org/current";
import { localWorkDate } from "@/lib/time/service";

/**
 * The client directory.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A MAP, NOT A THIRD TASK LIST. Browse already answers "show me tasks matching
 * X"; this answers "what work exists, and how is it arranged" — which client,
 * which engagement, how much is open, what is late. Every row leads INTO
 * Browse rather than rendering its own list, so there is one screen that
 * renders tasks and one definition of how they are filtered.
 *
 * SCOPED BY WORK, NOT BY CLIENT. A client appears because the user can see at
 * least one task on it. Listing every client in the firm and showing zeroes
 * would turn this page into a directory of the practice — which is
 * commercially sensitive and precisely what the relationship model exists to
 * withhold.
 *
 * CLOSED ENGAGEMENTS ARE SHOWN, dimmed, rather than hidden. Last year's audit
 * is a real thing people look for, and a page that silently omits it invites
 * the conclusion that the work was never recorded.
 * ─────────────────────────────────────────────────────────────────────────
 */

const OPEN: TaskStatus[] = [
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.REVIEW,
];

export interface EngagementRow {
  id: string;
  name: string;
  fy: string | null;
  status: string;
  partnerName: string | null;
  managerName: string | null;
  openTasks: number;
  overdue: number;
  loggedMinutes: number;
}

export interface ClientRow {
  id: string;
  name: string;
  code: string;
  partnerName: string | null;
  engagements: EngagementRow[];
  openTasks: number;
  overdue: number;
}

export async function getClientDirectory(user: ActingUser): Promise<ClientRow[]> {
  const org = await getCurrentOrganization();
  const today = localWorkDate(new Date(), org.timezone);

  // One pass over the visible tasks, then group. The alternative — a query per
  // client — is a page that gets slower as the firm grows, for no benefit at
  // the scale this runs at.
  const tasks = await prisma.task.findMany({
    where: visibleTaskFilter(user),
    select: {
      id: true,
      status: true,
      dueDate: true,
      actualMinutes: true,
      engagement: {
        select: {
          id: true,
          name: true,
          fy: true,
          status: true,
          partner: { select: { name: true } },
          manager: { select: { name: true } },
          client: {
            select: {
              id: true,
              name: true,
              code: true,
              relationshipPartner: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const clients = new Map<string, ClientRow>();
  const engagements = new Map<string, EngagementRow>();

  for (const t of tasks) {
    const e = t.engagement;
    const c = e.client;
    const clientKey = c.id.toString();
    const engKey = e.id.toString();

    if (!clients.has(clientKey)) {
      clients.set(clientKey, {
        id: clientKey,
        name: c.name,
        code: c.code,
        partnerName: c.relationshipPartner?.name ?? null,
        engagements: [],
        openTasks: 0,
        overdue: 0,
      });
    }

    if (!engagements.has(engKey)) {
      const row: EngagementRow = {
        id: engKey,
        name: e.name,
        fy: e.fy,
        status: e.status,
        partnerName: e.partner?.name ?? null,
        managerName: e.manager?.name ?? null,
        openTasks: 0,
        overdue: 0,
        loggedMinutes: 0,
      };
      engagements.set(engKey, row);
      clients.get(clientKey)!.engagements.push(row);
    }

    const client = clients.get(clientKey)!;
    const eng = engagements.get(engKey)!;

    // Hours logged counts ALL tasks including finished ones — unlike the
    // dashboard, which deliberately covers open work only. This page is where
    // someone asks what an engagement has cost so far, and excluding completed
    // work would answer a question nobody asked.
    eng.loggedMinutes += t.actualMinutes;

    const isOpen = OPEN.includes(t.status);
    if (!isOpen) continue;

    eng.openTasks += 1;
    client.openTasks += 1;

    if (t.dueDate < today) {
      eng.overdue += 1;
      client.overdue += 1;
    }
  }

  for (const client of clients.values()) {
    client.engagements.sort(
      (a, b) =>
        // Open work first — a closed engagement is history, and history sorts
        // below anything still live regardless of its name.
        Number(b.openTasks > 0) - Number(a.openTasks > 0) ||
        b.overdue - a.overdue ||
        a.name.localeCompare(b.name)
    );
  }

  return [...clients.values()].sort(
    (a, b) => b.overdue - a.overdue || b.openTasks - a.openTasks || a.name.localeCompare(b.name)
  );
}
