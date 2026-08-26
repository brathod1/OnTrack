import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { signIn, isEntraConfigured } from "@/lib/auth/auth";

export const metadata: Metadata = { title: "Sign in" };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isDev = process.env.NODE_ENV === "development";

/**
 * Error text shown to the user.
 *
 * Note that "pending approval" and "account disabled" say different things,
 * because both are states a legitimate colleague can be in and they need
 * different actions. "No such user", by contrast, is never surfaced — an
 * unknown address gets the generic message, so the page cannot be used to
 * discover who works here.
 */
const ERRORS: Record<string, string> = {
  pending_approval:
    "Your account is awaiting approval. An administrator will enable it shortly.",
  account_disabled: "This account has been disabled. Please contact your administrator.",
  missing_claims: "Sign-in failed: Microsoft did not return the expected account details.",
  session_invalid: "Your session is no longer valid. Please sign in again.",
  CredentialsSignin: "That account could not be signed in.",
  default: "Sign-in failed. Please try again.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? ERRORS.default) : null;

  // Only queried in development — the dev provider does not exist otherwise.
  const devUsers = isDev
    ? await prisma.user.findMany({
        where: { status: "ACTIVE" },
        select: { email: true, name: true, role: true, grade: true, team: { select: { name: true } } },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      })
    : [];

  async function signInWithEntra() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }

  async function signInAsDevUser(formData: FormData) {
    "use server";
    await signIn("dev", { email: String(formData.get("email") ?? ""), redirectTo: "/" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">OnTrack</h1>
          <p className="mt-1 text-sm text-slate-600">Internal task and time management</p>
        </div>

        {message && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {message}
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {isEntraConfigured ? (
            <form action={signInWithEntra}>
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Sign in with Microsoft
              </button>
            </form>
          ) : (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <p className="font-medium text-slate-800">Microsoft sign-in not yet configured</p>
              <p className="mt-1">
                The Entra ID app registration is pending approval. Once its three
                environment variables are set, this button appears automatically —
                no code change needed.
              </p>
            </div>
          )}

          {isDev && devUsers.length > 0 && (
            <>
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200" />
                <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Development only
                </span>
                <div className="h-px flex-1 bg-slate-200" />
              </div>

              <p className="mb-3 text-xs text-slate-500">
                Sign in as any seeded user. This provider is disabled outside
                development and can only sign in accounts that already exist.
              </p>

              <ul className="space-y-1.5">
                {devUsers.map((u) => (
                  <li key={u.email}>
                    <form action={signInAsDevUser}>
                      <input type="hidden" name="email" value={u.email} />
                      <button
                        type="submit"
                        className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:border-slate-400 hover:bg-slate-50"
                      >
                        <span>
                          <span className="font-medium text-slate-900">{u.name}</span>
                          <span className="ml-2 text-xs text-slate-500">
                            {u.team?.name ?? "No team"}
                          </span>
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600">
                          {u.role}
                        </span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          )}

          {isDev && devUsers.length === 0 && (
            <p className="mt-6 text-sm text-slate-500">
              No active users found. Run <code className="rounded bg-slate-100 px-1">npm run db:seed</code> first.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
