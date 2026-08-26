import Link from "next/link";

/**
 * Rendered when a task key does not resolve.
 *
 * ⚠ This page is shown for BOTH "no such task" and "a task you may not see".
 * The wording must never distinguish them. `getTaskDetail` loads through
 * `visibleTaskFilter`, so a task outside the caller's relationships simply is
 * not found — and saying "you don't have access to this task" would confirm
 * it exists, which is exactly what someone walking task keys wants to learn.
 *
 * Same page, same words, same 404 status.
 */
export default function TaskNotFound() {
  return (
    <main className="mx-auto max-w-lg px-6 py-20 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Task not found</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-slate-600">
        That task doesn&apos;t exist, or it has been removed. Check the task key
        and try again.
      </p>
      <Link
        href="/tasks"
        className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Back to my work
      </Link>
    </main>
  );
}
