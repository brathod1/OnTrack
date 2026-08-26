import { prisma } from "@/lib/db";
import { requireActingUser, getSessionUser } from "@/lib/auth/session";
import { visibleTaskFilter } from "@/lib/auth/permissions";
import { signOut } from "@/lib/auth/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stage 4 landing page.
 *
 * Replaced by the real "My Work" page at Stage 7. Until then it earns its
 * place by making the permission kernel VISIBLE: it lists the tasks this
 * particular user may see, through exactly the same `visibleTaskFilter` the
 * whole application uses.
 *
 * Sign in as different seeded users and the list changes. That is the entire
 * Stage 3 test suite, made tangible.
 */
export default async function Home() {
  const actor = await requireActingUser();
  const session = await getSessionUser();

  const [visible, totalInFirm, tasks] = await Promise.all([
    prisma.task.count({ where: visibleTaskFilter(actor) }),
    prisma.task.count({ where: { deletedAt: null } }),
    prisma.task.findMany({
      where: visibleTaskFilter(actor),
      select: {
        displayKey: true,
        title: true,
        status: true,
        dueDate: true,
        isBlocked: true,
        assignee: { select: { name: true } },
        engagement: { select: { name: true, client: { select: { name: true, code: true } } } },
      },
      orderBy: [{ dueDate: "asc" }],
      take: 50,
    }),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OnTrack</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{session?.name}</span>
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-600">
              {actor.role}
            </span>
          </p>
        </div>
        <form action={doSignOut}>
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Sign out
          </button>
        </form>
      </header>

      <section className="mt-6 grid grid-cols-3 gap-4">
        <Stat label="Visible to you" value={visible} />
        <Stat label="In the firm" value={totalInFirm} />
        <Stat label="Your engagements" value={actor.engagementIds.length} />
      </section>

      <p className="mt-4 text-sm text-slate-600">
        {visible === totalInFirm ? (
          <>You can see every task in the firm.</>
        ) : (
          <>
            You can see <strong>{visible}</strong> of <strong>{totalInFirm}</strong> tasks.
            The other {totalInFirm - visible} belong to clients and engagements you have no
            relationship to — the same rule the test suite verifies.
          </>
        )}
        {actor.reportChainIds.length > 0 && (
          <> You also oversee {actor.reportChainIds.length} {actor.reportChainIds.length === 1 ? "person" : "people"}.</>
        )}
      </p>

      <div className="mt-8 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Task</th>
              <th className="px-4 py-2.5 font-medium">Client</th>
              <th className="px-4 py-2.5 font-medium">Assignee</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tasks.map((t) => {
              const overdue =
                t.dueDate < today && !["COMPLETED", "CANCELLED"].includes(t.status);
              return (
                <tr key={t.displayKey} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <span className="tabular text-xs text-slate-400">{t.displayKey}</span>
                    <span className="ml-2 text-slate-900">{t.title}</span>
                    {t.isBlocked && (
                      <span className="ml-2 rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800">
                        BLOCKED
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{t.engagement.client.code}</td>
                  <td className="px-4 py-2.5 text-slate-600">{t.assignee.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{t.status.replace("_", " ")}</td>
                  <td
                    className={`tabular px-4 py-2.5 text-right ${
                      overdue ? "font-medium text-red-700" : "text-slate-600"
                    }`}
                  >
                    {t.dueDate.toISOString().slice(0, 10)}
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No tasks visible to you.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-sm text-slate-500">
        Stage 4. This page is replaced by the real task views at Stage 7.
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
