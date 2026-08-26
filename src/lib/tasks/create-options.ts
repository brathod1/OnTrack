import { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { can, canCreateTask, type ActingUser } from "@/lib/auth/permissions";
import { CAP } from "@/lib/auth/capabilities";

/**
 * The data behind the quick-create form.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The important part is `people`, which carries each candidate's CURRENT
 * LOAD — open task count and remaining estimated hours.
 *
 * Showing that in the assignee picker means overload is visible AT THE MOMENT
 * OF DELEGATION, rather than in a report next week once the work has already
 * landed on someone drowning. One line of context at the point of decision
 * does more for workload management than any dashboard, because a dashboard is
 * read after the fact by someone who has to then undo what they did.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface EngagementOption {
  id: string;
  label: string;
  clientCode: string;
  defaultReviewRequired: boolean;
  /** Most recently used engagements first — see the ordering note below. */
  recentlyUsed: boolean;
}

export interface PersonOption {
  id: string;
  name: string;
  teamName: string | null;
  /** Free text since G5, and optional — not every organisation uses levels. */
  grade: string | null;
  openTasks: number;
  remainingMinutes: number;
  overdueTasks: number;
}

export interface CreateOptions {
  engagements: EngagementOption[];
  people: PersonOption[];
}

const OPEN: TaskStatus[] = [TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS, TaskStatus.REVIEW];

export async function getCreateOptions(user: ActingUser): Promise<CreateOptions> {
  const candidates = await prisma.engagement.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { id: { in: user.engagementIds } },
        { partnerId: user.id },
        { managerId: user.id },
        // Someone who administers the organisation may create work anywhere.
        // This widens the candidate set only — canCreateTask below is still
        // the actual decision.
        ...(can(user, CAP.MANAGE_ORGANIZATION) ? [{}] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      fy: true,
      partnerId: true,
      managerId: true,
      defaultReviewRequired: true,
      client: { select: { code: true, name: true } },
      team: { select: { membersCanCreateTasks: true } },
    },
    orderBy: [{ client: { name: "asc" } }, { name: "asc" }],
  });

  // Filter through the kernel rather than trusting the query. The `where`
  // above is an optimisation to avoid loading every engagement; this is the
  // actual permission decision, and it is the same function the API uses.
  const permitted = candidates.filter((e) =>
    canCreateTask(user, {
      engagementId: e.id,
      partnerId: e.partnerId,
      managerId: e.managerId,
      membersCanCreateTasks: e.team?.membersCanCreateTasks ?? true,
      isActive: true,
    })
  );

  /**
   * Engagements this user has touched in the last 30 days float to the top.
   *
   * A manager creating tasks is almost always working through one engagement
   * at a time — twenty GST tasks, then twenty audit tasks. Alphabetical order
   * makes them hunt for the same entry twenty times.
   */
  const recent = await prisma.task.findMany({
    where: {
      createdById: user.id,
      createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
    },
    select: { engagementId: true },
    distinct: ["engagementId"],
    take: 10,
  });
  const recentIds = new Set(recent.map((r) => r.engagementId.toString()));

  const engagements: EngagementOption[] = permitted
    .map((e) => ({
      id: e.id.toString(),
      label: e.fy ? `${e.name} ${e.fy}` : e.name,
      clientCode: e.client.code,
      defaultReviewRequired: e.defaultReviewRequired,
      recentlyUsed: recentIds.has(e.id.toString()),
    }))
    .sort((a, b) => Number(b.recentlyUsed) - Number(a.recentlyUsed));

  // ── Who can be assigned ──────────────────────────────────────────────────
  // Everyone active. Assignment adds them to the engagement (see the service),
  // so restricting this list to existing members would make staffing someone
  // new impossible from the one screen where you actually want to do it.
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      grade: true,
      team: { select: { name: true } },
      tasksAssigned: {
        where: { status: { in: OPEN }, deletedAt: null },
        select: {
          currentEstimateMinutes: true,
          actualMinutes: true,
          dueDate: true,
          subtasks: { select: { id: true } },
        },
      },
    },
    orderBy: [{ name: "asc" }],
  });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const people: PersonOption[] = users.map((u) => {
    let remainingMinutes = 0;
    let overdueTasks = 0;

    for (const t of u.tasksAssigned) {
      // Leaf tasks only, for the same reason as the My Work figure: a parent
      // and its children describe the same work.
      if (t.subtasks.length === 0 && t.currentEstimateMinutes !== null) {
        remainingMinutes += Math.max(0, t.currentEstimateMinutes - t.actualMinutes);
      }
      if (t.dueDate < today) overdueTasks += 1;
    }

    return {
      id: u.id.toString(),
      name: u.name,
      teamName: u.team?.name ?? null,
      grade: u.grade,
      openTasks: u.tasksAssigned.length,
      remainingMinutes,
      overdueTasks,
    };
  });

  return { engagements, people };
}
