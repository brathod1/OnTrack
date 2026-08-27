import { prisma } from "@/lib/db";
import { visibleTaskFilter, type ActingUser } from "@/lib/auth/permissions";
import { getCurrentOrganization } from "@/lib/org/current";
import { localWorkDate } from "@/lib/time/service";

/**
 * Hours over a date range, by client, engagement and person.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READS THE LEDGER, NOT THE CACHE. `task.actualMinutes` is a lifetime total;
 * a report bounded by dates must count each entry on its own `work_date`.
 * Using the cached figure would produce a report that looked right, summed
 * correctly, and silently ignored the date range it was titled with.
 *
 * SUSPENDED ENTRIES ARE EXCLUDED AND COUNTED SEPARATELY. An unconfirmed timer
 * is not hours worked. But omitting it in silence would leave a partner asking
 * why a week looks light, so the report says how much is waiting.
 *
 * SCOPE IS THE TASK'S, NOT THE ENTRY'S. A time entry is visible because the
 * TASK it belongs to is visible — the same `visibleTaskFilter` as everywhere
 * else. There is no separate notion of "whose hours you may see", which is
 * what would eventually drift.
 *
 * WHAT THIS IS NOT: a productivity report. It carries no rate per person, no
 * utilisation percentage, no comparison between people. It answers where the
 * firm's effort went, which is a question about WORK.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface PersonHours {
  userId: string;
  name: string;
  minutes: number;
}

export interface EngagementHours {
  engagementId: string;
  name: string;
  fy: string | null;
  minutes: number;
  people: PersonHours[];
}

export interface ClientHours {
  clientId: string;
  name: string;
  code: string;
  minutes: number;
  engagements: EngagementHours[];
}

/** One row per time entry, for the spreadsheet. */
export interface ReportLine {
  workDate: Date;
  clientName: string;
  clientCode: string;
  engagementName: string;
  taskKey: string;
  taskTitle: string;
  personName: string;
  minutes: number;
  source: string;
  note: string | null;
}

export interface TimeReport {
  from: Date;
  to: Date;
  clients: ClientHours[];
  people: PersonHours[];
  totalMinutes: number;
  entryCount: number;
  /** Unconfirmed timers in range — excluded from every total above. */
  suspendedCount: number;
  suspendedMinutesIfConfirmed: number;
  lines: ReportLine[];
}

export interface TimeReportFilters {
  from: Date;
  to: Date;
  clientId?: bigint;
  userId?: bigint;
}

/** The current month to date — the range someone almost always wants first. */
export async function defaultRange(): Promise<{ from: Date; to: Date }> {
  const org = await getCurrentOrganization();
  const today = localWorkDate(new Date(), org.timezone);
  const from = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)
  );
  return { from, to: today };
}

export async function getTimeReport(
  user: ActingUser,
  filters: TimeReportFilters
): Promise<TimeReport> {
  const entries = await prisma.timeEntry.findMany({
    where: {
      deletedAt: null,
      workDate: { gte: filters.from, lte: filters.to },
      ...(filters.userId ? { userId: filters.userId } : {}),
      task: {
        AND: [
          visibleTaskFilter(user),
          ...(filters.clientId
            ? [{ engagement: { clientId: filters.clientId } }]
            : []),
        ],
      },
    },
    select: {
      workDate: true,
      durationMinutes: true,
      isSuspended: true,
      source: true,
      note: true,
      user: { select: { id: true, name: true } },
      task: {
        select: {
          displayKey: true,
          title: true,
          engagement: {
            select: {
              id: true,
              name: true,
              fy: true,
              client: { select: { id: true, name: true, code: true } },
            },
          },
        },
      },
    },
    orderBy: [{ workDate: "asc" }, { id: "asc" }],
  });

  const clients = new Map<string, ClientHours>();
  const engagements = new Map<string, EngagementHours>();
  const engagementPeople = new Map<string, Map<string, PersonHours>>();
  const people = new Map<string, PersonHours>();
  const lines: ReportLine[] = [];

  let totalMinutes = 0;
  let entryCount = 0;
  let suspendedCount = 0;
  let suspendedMinutesIfConfirmed = 0;

  for (const e of entries) {
    if (e.isSuspended) {
      // Not hours worked. Counted apart so a light-looking week has a stated
      // reason rather than an unexplained gap.
      suspendedCount += 1;
      suspendedMinutesIfConfirmed += e.durationMinutes;
      continue;
    }

    const eng = e.task.engagement;
    const c = eng.client;
    const clientKey = c.id.toString();
    const engKey = eng.id.toString();
    const personKey = e.user.id.toString();

    if (!clients.has(clientKey)) {
      clients.set(clientKey, {
        clientId: clientKey,
        name: c.name,
        code: c.code,
        minutes: 0,
        engagements: [],
      });
    }

    if (!engagements.has(engKey)) {
      const row: EngagementHours = {
        engagementId: engKey,
        name: eng.name,
        fy: eng.fy,
        minutes: 0,
        people: [],
      };
      engagements.set(engKey, row);
      engagementPeople.set(engKey, new Map());
      clients.get(clientKey)!.engagements.push(row);
    }

    if (!people.has(personKey)) {
      people.set(personKey, { userId: personKey, name: e.user.name, minutes: 0 });
    }

    const perEng = engagementPeople.get(engKey)!;
    if (!perEng.has(personKey)) {
      const row: PersonHours = { userId: personKey, name: e.user.name, minutes: 0 };
      perEng.set(personKey, row);
      engagements.get(engKey)!.people.push(row);
    }

    clients.get(clientKey)!.minutes += e.durationMinutes;
    engagements.get(engKey)!.minutes += e.durationMinutes;
    perEng.get(personKey)!.minutes += e.durationMinutes;
    people.get(personKey)!.minutes += e.durationMinutes;

    totalMinutes += e.durationMinutes;
    entryCount += 1;

    lines.push({
      workDate: e.workDate,
      clientName: c.name,
      clientCode: c.code,
      engagementName: eng.name,
      taskKey: e.task.displayKey,
      taskTitle: e.task.title,
      personName: e.user.name,
      minutes: e.durationMinutes,
      source: e.source,
      note: e.note,
    });
  }

  const byMinutes = <T extends { minutes: number }>(a: T, b: T) => b.minutes - a.minutes;

  const clientRows = [...clients.values()].sort(byMinutes);
  for (const c of clientRows) {
    c.engagements.sort(byMinutes);
    for (const eng of c.engagements) eng.people.sort(byMinutes);
  }

  return {
    from: filters.from,
    to: filters.to,
    clients: clientRows,
    people: [...people.values()].sort(byMinutes),
    totalMinutes,
    entryCount,
    suspendedCount,
    suspendedMinutesIfConfirmed,
    lines,
  };
}
