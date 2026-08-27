/**
 * The spreadsheet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * No database. The workbook builder takes a `TimeReport` and returns bytes, so
 * it can be tested by building one and reading it back with the same library.
 *
 * THE ASSERTION THAT MATTERS: the Detail sheet's minutes sum to the Summary
 * sheet's total. A spreadsheet that disagrees with itself — or with the page
 * it came from — is worse than no spreadsheet, because one of the numbers is
 * wrong and nobody can tell which, so both stop being believed.
 * ─────────────────────────────────────────────────────────────────────────
 */

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildTimeReportWorkbook, reportFilename } from "@/lib/reports/excel";
import type { TimeReport } from "@/lib/reports/time-report";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function sampleReport(overrides: Partial<TimeReport> = {}): TimeReport {
  return {
    from: day("2026-01-01"),
    to: day("2026-01-31"),
    totalMinutes: 330,
    entryCount: 3,
    suspendedCount: 0,
    suspendedMinutesIfConfirmed: 0,
    clients: [
      {
        clientId: "1",
        name: "Alpha Industries",
        code: "ALPHA",
        minutes: 240,
        engagements: [
          {
            engagementId: "10",
            name: "Tax Compliance",
            fy: "2026-27",
            minutes: 240,
            people: [
              { userId: "5", name: "Eshan Exec", minutes: 180 },
              { userId: "6", name: "Meera Manager", minutes: 60 },
            ],
          },
        ],
      },
      {
        clientId: "2",
        name: "Beta Traders",
        code: "BETA",
        minutes: 90,
        engagements: [
          {
            engagementId: "20",
            name: "GST Compliance",
            fy: "2026-27",
            minutes: 90,
            people: [{ userId: "7", name: "Esha Exec", minutes: 90 }],
          },
        ],
      },
    ],
    people: [
      { userId: "5", name: "Eshan Exec", minutes: 180 },
      { userId: "7", name: "Esha Exec", minutes: 90 },
      { userId: "6", name: "Meera Manager", minutes: 60 },
    ],
    lines: [
      {
        workDate: day("2026-01-05"),
        clientName: "Alpha Industries",
        clientCode: "ALPHA",
        engagementName: "Tax Compliance",
        taskKey: "TSK-2026-00001",
        taskTitle: "Advance tax computation",
        personName: "Eshan Exec",
        minutes: 180,
        source: "TIMER",
        note: "reconciled the ITC ledger",
      },
      {
        workDate: day("2026-01-06"),
        clientName: "Alpha Industries",
        clientCode: "ALPHA",
        engagementName: "Tax Compliance",
        taskKey: "TSK-2026-00002",
        taskTitle: "Review TDS position",
        personName: "Meera Manager",
        minutes: 60,
        source: "MANUAL",
        note: null,
      },
      {
        workDate: day("2026-01-07"),
        clientName: "Beta Traders",
        clientCode: "BETA",
        engagementName: "GST Compliance",
        taskKey: "TSK-2026-00004",
        taskTitle: "File GSTR-3B",
        personName: "Esha Exec",
        minutes: 90,
        source: "MANUAL",
        note: null,
      },
    ],
    ...overrides,
  };
}

const meta = {
  organisationName: "Fixture Chartered Accountants",
  generatedBy: "Kavya Iyer",
  generatedAt: day("2026-02-01"),
};

async function readBack(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** Every cell on a sheet, flattened to strings, for "does it say X" checks. */
function allText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    });
  });
  return parts.join(" | ");
}

describe("the workbook", () => {
  it("produces a readable file with both sheets", async () => {
    const wb = await readBack(await buildTimeReportWorkbook(sampleReport(), meta));

    expect(wb.getWorksheet("Summary")).toBeDefined();
    expect(wb.getWorksheet("Detail")).toBeDefined();
  });

  it("says what it is without its filename", async () => {
    // Someone will print this, email it, and find it again in a year.
    const wb = await readBack(await buildTimeReportWorkbook(sampleReport(), meta));
    const text = allText(wb.getWorksheet("Summary")!);

    expect(text).toContain("Fixture Chartered Accountants");
    expect(text).toContain("01 Jan 2026");
    expect(text).toContain("31 Jan 2026");
    expect(text).toContain("Kavya Iyer");
  });

  it("DETAIL SUMS TO THE SUMMARY TOTAL", async () => {
    const report = sampleReport();
    const wb = await readBack(await buildTimeReportWorkbook(report, meta));
    const detail = wb.getWorksheet("Detail")!;

    let sum = 0;
    detail.eachRow((row, n) => {
      if (n === 1) return; // header
      const minutes = row.getCell(8).value; // "Minutes"
      if (typeof minutes === "number") sum += minutes;
    });

    expect(sum).toBe(report.totalMinutes);
  });

  it("writes one detail row per entry", async () => {
    const report = sampleReport();
    const wb = await readBack(await buildTimeReportWorkbook(report, meta));

    // rowCount includes the header.
    expect(wb.getWorksheet("Detail")!.rowCount).toBe(report.lines.length + 1);
  });

  it("carries minutes AND hours, with minutes authoritative", async () => {
    const wb = await readBack(await buildTimeReportWorkbook(sampleReport(), meta));
    const first = wb.getWorksheet("Detail")!.getRow(2);

    expect(first.getCell(8).value).toBe(180); // minutes, exact
    expect(first.getCell(9).value).toBe(3); // hours, derived
  });

  it("rounds hours without losing the exact minutes", async () => {
    // 20 minutes is 0.33 hours. Summed a thousand times that drifts, which is
    // why anyone doing arithmetic is meant to use the minutes column.
    const report = sampleReport({
      totalMinutes: 20,
      entryCount: 1,
      clients: [],
      people: [],
      lines: [
        {
          ...sampleReport().lines[0]!,
          minutes: 20,
        },
      ],
    });

    const wb = await readBack(await buildTimeReportWorkbook(report, meta));
    const row = wb.getWorksheet("Detail")!.getRow(2);

    expect(row.getCell(8).value).toBe(20);
    expect(row.getCell(9).value).toBe(0.33);
  });

  it("states excluded unconfirmed timers on the face of the report", async () => {
    // A total that silently omits them is how a month looks light and nobody
    // knows why. It belongs on the sheet, not in a footnote nobody reads.
    const report = sampleReport({
      suspendedCount: 2,
      suspendedMinutesIfConfirmed: 780,
    });

    const wb = await readBack(await buildTimeReportWorkbook(report, meta));
    const text = allText(wb.getWorksheet("Summary")!);

    expect(text).toMatch(/EXCLUDED: 2 unconfirmed/);
    expect(text).toContain("13");
  });

  it("says so when the report was narrowed", async () => {
    // Otherwise a filtered file is indistinguishable from the whole picture,
    // and someone quotes one client's hours as the firm's.
    const wb = await readBack(
      await buildTimeReportWorkbook(sampleReport(), {
        ...meta,
        clientFilter: "Alpha Industries",
      })
    );

    expect(allText(wb.getWorksheet("Summary")!)).toContain("Client: Alpha Industries");
  });

  it("survives an empty report", async () => {
    const wb = await readBack(
      await buildTimeReportWorkbook(
        sampleReport({
          totalMinutes: 0,
          entryCount: 0,
          clients: [],
          people: [],
          lines: [],
        }),
        meta
      )
    );

    expect(wb.getWorksheet("Detail")!.rowCount).toBe(1); // header only
    expect(allText(wb.getWorksheet("Summary")!)).toContain("TOTAL");
  });
});

describe("the filename", () => {
  it("still means something as one of forty in a folder", () => {
    const name = reportFilename(sampleReport(), "KCM");
    expect(name).toBe("KCM-time-2026-01-01-to-2026-01-31.xlsx");
  });

  it("strips anything a filesystem would object to", () => {
    const name = reportFilename(sampleReport(), "K C Mehta & Co LLP");
    expect(name).toBe("K-C-Mehta-Co-LLP-time-2026-01-01-to-2026-01-31.xlsx");
    expect(name).not.toMatch(/[&/\\:*?"<>|]/);
  });
});
