import Link from "next/link";
import { requireActingUser, getSessionUser } from "@/lib/auth/session";
import { canOverseeOthers, canViewAllTasks } from "@/lib/auth/permissions";
import { getTerminology } from "@/lib/org/terminology";
import { signOut } from "@/lib/auth/auth";
import { HeaderTimer } from "@/components/header-timer";
import { getRunningTimer } from "@/lib/time/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The application shell.
 *
 * Every page inside the (app) route group gets authentication and navigation.
 * `requireActingUser()` runs here, so no page beneath it can forget to check —
 * and because it re-reads role and engagements from the database on every
 * request, a deactivated user stops working immediately rather than when their
 * session happens to expire.
 *
 * Navigation is deliberately short — a handful of items, not a sidebar of
 * twenty: a professional tool people use all day rewards knowing where
 * everything is over discovering it. Timesheet earned its place because it is
 * a weekly destination in its own right; anything used less often than that
 * belongs on a page, not in the shell.
 *
 * The running timer lives here too, for the same reason the nav is short: it
 * must be impossible to miss. A timer out of sight is a timer left running.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActingUser();
  const session = await getSessionUser();
  // "Clients" for a CA firm, "Customers" or "Projects" elsewhere. The nav
  // reads from configuration rather than from a string literal here.
  const terms = await getTerminology();

  const canSeeAll = canViewAllTasks(actor);
  // A capability question, not "is this person senior enough". An organisation
  // that gives its team leads task.assign gets the Team view for them without
  // anyone editing this file.
  const showTeamView = canOverseeOthers(actor);

  // A timer you have to go and find is a timer left running, so the clock sits
  // in the shell rather than on one page. One indexed lookup per request.
  const running = await getRunningTimer(actor.id);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link href="/tasks" className="py-3 text-base font-semibold tracking-tight">
            OnTrack
          </Link>

          <nav className="flex flex-1 items-center gap-1 overflow-x-auto" aria-label="Main">
            <NavLink href="/tasks">My work</NavLink>
            <NavLink href="/timesheet">Timesheet</NavLink>
            {showTeamView && <NavLink href="/team">Team</NavLink>}
            <NavLink href="/clients">{terms.plural("client")}</NavLink>
            {canSeeAll && <NavLink href="/tasks/all">All {terms.plural("task").toLowerCase()}</NavLink>}
          </nav>

          <div className="flex items-center gap-3">
            <HeaderTimer
              running={
                running?.startedAt
                  ? {
                      taskId: running.taskId.toString(),
                      taskKey: running.task.displayKey,
                      taskTitle: running.task.title,
                      startedAt: running.startedAt.toISOString(),
                      isSuspended: running.isSuspended,
                    }
                  : null
              }
              serverNow={new Date().toISOString()}
            />
            <span className="hidden text-sm text-slate-600 sm:inline">{session?.name}</span>
            <form action={doSignOut}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
    >
      {children}
    </Link>
  );
}
