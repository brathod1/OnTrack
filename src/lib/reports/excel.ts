import ExcelJS from "exceljs";
import { format as formatDate } from "date-fns";
import type { TimeReport } from "./time-report";

/**
 * The time report as a spreadsheet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BUILT FROM THE SAME `TimeReport` THE SCREEN RENDERS. Not a second query.
 * A spreadsheet that disagrees with the page it came from is worse than no
 * spreadsheet at all — one of them is wrong and nobody can tell which, so
 * both stop being trusted.
 *
 * MINUTES ARE AUTHORITATIVE; HOURS ARE A CONVENIENCE. Every row carries both.
 * The ledger stores integer minutes, and 20 minutes is 0.33 hours — rounded,
 * summed a thousand times, that drifts. Anyone doing arithmetic should use the
 * minutes column; the hours column exists because people multiply by a rate.
 *
 * TWO SHEETS, DELIBERATELY. Summary answers "where did the month go" at a
 * glance. Detail is every entry, because the first question after a surprising
 * total is always "made up of what?" — and a report that cannot answer it
 * sends someone back to the application to find out.
 * ─────────────────────────────────────────────────────────────────────────
 */

const DATE_FMT = "dd MMM yyyy";

/** Integer minutes to decimal hours, two places. */
function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export interface WorkbookMeta {
  organisationName: string;
  /** Who ran it. A report that leaves the building should say who produced it. */
  generatedBy: string;
  generatedAt: Date;
  /** Named when the report was narrowed, so the file cannot be mistaken for the whole. */
  clientFilter?: string;
  personFilter?: string;
}

export async function buildTimeReportWorkbook(
  report: TimeReport,
  meta: WorkbookMeta
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OnTrack";
  wb.created = meta.generatedAt;

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = wb.addWorksheet("Summary");

  summary.columns = [
    { header: "Client", key: "client", width: 32 },
    { header: "Code", key: "code", width: 12 },
    { header: "Engagement", key: "engagement", width: 30 },
    { header: "Person", key: "person", width: 24 },
    { header: "Minutes", key: "minutes", width: 12 },
    { header: "Hours", key: "hours", width: 10 },
  ];

  // A header block before the table. Someone will print this, email it, and
  // find it again in a year — it has to say what it is without its filename.
  summary.spliceRows(1, 0,
    [meta.organisationName],
    [`Time report · ${formatDate(report.from, DATE_FMT)} to ${formatDate(report.to, DATE_FMT)}`],
    [
      [
        meta.clientFilter ? `Client: ${meta.clientFilter}` : null,
        meta.personFilter ? `Person: ${meta.personFilter}` : null,
      ]
        .filter(Boolean)
        .join("   ") || "All clients and people you can see",
    ],
    [`Prepared by ${meta.generatedBy} on ${formatDate(meta.generatedAt, DATE_FMT)}`],
    [],
  );

  summary.getRow(1).font = { bold: true, size: 14 };
  summary.getRow(2).font = { bold: true };
  summary.getRow(3).font = { italic: true, color: { argb: "FF666666" } };
  summary.getRow(4).font = { italic: true, color: { argb: "FF666666" } };
  summary.getRow(6).font = { bold: true };

  for (const client of report.clients) {
    for (const eng of client.engagements) {
      for (const person of eng.people) {
        summary.addRow({
          client: client.name,
          code: client.code,
          engagement: eng.name,
          person: person.name,
          minutes: person.minutes,
          hours: hours(person.minutes),
        });
      }

      const engRow = summary.addRow({
        engagement: `${eng.name} — total`,
        minutes: eng.minutes,
        hours: hours(eng.minutes),
      });
      engRow.font = { italic: true };
    }

    const clientRow = summary.addRow({
      client: `${client.name} — total`,
      minutes: client.minutes,
      hours: hours(client.minutes),
    });
    clientRow.font = { bold: true };
    summary.addRow({});
  }

  const grand = summary.addRow({
    client: "TOTAL",
    minutes: report.totalMinutes,
    hours: hours(report.totalMinutes),
  });
  grand.font = { bold: true, size: 12 };

  // Stated on the face of the report, not in a footnote nobody reads. A total
  // that silently omits unconfirmed timers is how a month looks light and
  // nobody knows why.
  if (report.suspendedCount > 0) {
    summary.addRow({});
    const warn = summary.addRow({
      client: `EXCLUDED: ${report.suspendedCount} unconfirmed timer(s), up to ${hours(
        report.suspendedMinutesIfConfirmed
      )} hours, awaiting confirmation by the people who ran them.`,
    });
    warn.font = { italic: true, color: { argb: "FFB45309" } };
  }

  // ── Detail ────────────────────────────────────────────────────────────────
  const detail = wb.addWorksheet("Detail");

  detail.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Client", key: "client", width: 30 },
    { header: "Code", key: "code", width: 12 },
    { header: "Engagement", key: "engagement", width: 28 },
    { header: "Task", key: "taskKey", width: 18 },
    { header: "Title", key: "title", width: 44 },
    { header: "Person", key: "person", width: 24 },
    { header: "Minutes", key: "minutes", width: 12 },
    { header: "Hours", key: "hours", width: 10 },
    { header: "Entered", key: "source", width: 12 },
    { header: "Note", key: "note", width: 50 },
  ];
  detail.getRow(1).font = { bold: true };
  detail.views = [{ state: "frozen", ySplit: 1 }];

  for (const line of report.lines) {
    detail.addRow({
      // A date, not a timestamp: work_date is a calendar day and rendering it
      // as an instant would invite a timezone question that does not exist.
      date: formatDate(line.workDate, DATE_FMT),
      client: line.clientName,
      code: line.clientCode,
      engagement: line.engagementName,
      taskKey: line.taskKey,
      title: line.taskTitle,
      person: line.personName,
      minutes: line.minutes,
      hours: hours(line.minutes),
      source: line.source === "TIMER" ? "Timer" : "Manual",
      note: line.note ?? "",
    });
  }

  detail.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: detail.columns.length },
  };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** A filename that still means something when it is one of forty in a folder. */
export function reportFilename(report: TimeReport, organisationShortName: string): string {
  const safe = organisationShortName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${safe || "OnTrack"}-time-${formatDate(report.from, "yyyy-MM-dd")}-to-${formatDate(
    report.to,
    "yyyy-MM-dd"
  )}.xlsx`;
}
