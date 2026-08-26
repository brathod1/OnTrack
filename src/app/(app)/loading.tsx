/**
 * Navigation placeholder.
 *
 * A skeleton in the shape of the content rather than a spinner: it keeps the
 * layout stable, so nothing jumps when the data lands. On a screen opened
 * twenty times a day, that jump is more irritating than the wait.
 *
 * `animate-pulse` respects prefers-reduced-motion through Tailwind's default
 * configuration.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-40 rounded bg-slate-200" />
      <div className="mt-2 h-4 w-24 rounded bg-slate-100" />

      <div className="mt-6 space-y-6">
        {[3, 2].map((rows, section) => (
          <div key={section}>
            <div className="mb-2 h-4 w-28 rounded bg-slate-200" />
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {Array.from({ length: rows }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-slate-100 px-3 py-3 last:border-b-0"
                >
                  <div className="h-3 w-3 rounded-full bg-slate-100" />
                  <div className="flex-1">
                    <div className="h-4 w-2/3 rounded bg-slate-200" />
                    <div className="mt-1.5 h-3 w-1/3 rounded bg-slate-100" />
                  </div>
                  <div className="h-5 w-20 rounded bg-slate-100" />
                  <div className="h-4 w-16 rounded bg-slate-100" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
