import { requireActingUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { CAP } from "@/lib/auth/capabilities";
import { prisma } from "@/lib/db";
import { getCurrentOrganization } from "@/lib/org/current";
import { defaultRange, getTimeReport } from "@/lib/reports/time-report";
import { buildTimeReportWorkbook, reportFilename } from "@/lib/reports/excel";

/**
 * The time report as a downloadable spreadsheet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A ROUTE HANDLER, NOT A SERVER ACTION. Actions return values to a React tree;
 * this has to return a file with headers a browser will save.
 *
 * IT RE-CHECKS EVERYTHING. The page already gates on VIEW_REPORTS, but this
 * URL is reachable directly — pasted, bookmarked, or guessed. A download
 * endpoint that trusts the page that linked to it is a download endpoint with
 * no authorisation at all. Scope comes from the same `getTimeReport`, which
 * composes the same `visibleTaskFilter`.
 * ─────────────────────────────────────────────────────────────────────────
 */

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v: string | null): v is string => !!v && /^\d+$/.test(v);

export async function GET(request: Request) {
  const user = await requireActingUser();

  if (!can(user, CAP.VIEW_REPORTS)) {
    // 404, consistent with every other refusal in the product. A 403 here
    // would confirm the report exists and is merely withheld.
    return new Response("Not found", { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const fallback = await defaultRange();

  const from = isDate(params.get("from"))
    ? new Date(`${params.get("from")}T00:00:00.000Z`)
    : fallback.from;
  const to = isDate(params.get("to"))
    ? new Date(`${params.get("to")}T00:00:00.000Z`)
    : fallback.to;

  if (from > to) {
    return new Response("The start date is after the end date.", { status: 400 });
  }

  const clientId = isId(params.get("client")) ? BigInt(params.get("client")!) : undefined;
  const userId = isId(params.get("person")) ? BigInt(params.get("person")!) : undefined;

  const [report, org] = await Promise.all([
    getTimeReport(user, { from, to, clientId, userId }),
    getCurrentOrganization(),
  ]);

  // Names for the header block. Looked up only when the filter is in play, and
  // through the report's own scope — a filter naming a client the user cannot
  // see would otherwise disclose that the client exists.
  const [clientName, personName, author] = await Promise.all([
    clientId
      ? prisma.client
          .findFirst({ where: { id: clientId }, select: { name: true } })
          .then((c) => c?.name)
      : Promise.resolve(undefined),
    userId
      ? prisma.user
          .findFirst({ where: { id: userId }, select: { name: true } })
          .then((u) => u?.name)
      : Promise.resolve(undefined),
    // ActingUser carries capabilities and scope, not a display name — it is a
    // permission subject, not a profile. The report needs a person's name on
    // it, so it is fetched rather than assumed to be there.
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { name: true },
    }),
  ]);

  const buffer = await buildTimeReportWorkbook(report, {
    organisationName: org.name,
    generatedBy: author.name,
    generatedAt: new Date(),
    clientFilter: clientName,
    personFilter: personName,
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${reportFilename(
        report,
        org.shortName ?? org.name
      )}"`,
      // A report is a snapshot of live data. Cached, someone downloads last
      // week's figures believing they are today's.
      "Cache-Control": "no-store",
    },
  });
}
