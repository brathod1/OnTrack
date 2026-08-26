import Link from "next/link";
import { requireActingUser, getSessionUser } from "@/lib/auth/session";
import { canViewAllTasks } from "@/lib/auth/permissions";
import { signOut } from "@/lib/auth/auth";

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
 * Navigation is deliberately short. Four items, not a sidebar of twenty: a
 * professional tool people use all day rewards knowing where everything is
 * over discovering it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActingUser();
  const session = await getSessionUser();

  const canSeeAll = canViewAllTasks(actor);
  const isManagerOrAbove = actor.role !== "MEMBER";

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
            {isManagerOrAbove && <NavLink href="/team">Team</NavLink>}
            <NavLink href="/clients">Clients</NavLink>
            {canSeeAll && <NavLink href="/tasks/all">All tasks</NavLink>}
          </nav>

          <div className="flex items-center gap-3">
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
