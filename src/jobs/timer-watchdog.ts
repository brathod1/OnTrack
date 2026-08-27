/**
 * The forgotten-timer watchdog, as a runnable job.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Run it hourly:  npm run watchdog
 *
 * DELIBERATELY A PLAIN SCRIPT, NOT A QUEUED JOB.
 *
 * pg-boss is in package.json and will earn its place when notifications need
 * a queue, but this job needs none of what a queue provides. It is idempotent
 * (a second run suspends nothing new), and the ceiling it enforces is ten
 * hours — so a missed run is caught by the next one and costs nothing. Retries
 * and dead-lettering protect against losing work that matters exactly once;
 * this work does not matter exactly once.
 *
 * It also keeps the restricted runtime role intact. pg-boss creates and owns
 * its own schema, which `ontrack_app` cannot do by design.
 *
 * WHICH SCHEDULER runs this is a deployment decision, not an application one —
 * Windows Task Scheduler, cron, an Azure WebJob or a GitHub Action all work,
 * because this is just a process that exits. Stage 16 picks one.
 *
 * EXIT CODES: 0 whether or not anything was suspended (finding nothing is a
 * successful run, not a failure). Non-zero only if the job could not complete,
 * so a scheduler's failure alerting means something.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { prisma } from "@/lib/db";
import { runTimerWatchdog } from "@/lib/time/watchdog";

async function main() {
  const startedAt = Date.now();
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    // Report what WOULD be suspended without writing. Useful the first time
    // this is scheduled, when nobody yet trusts it not to mangle live data.
    const { watchdogHours } = await import("@/lib/time/service");
    const ceiling = watchdogHours();
    const cutoff = new Date(Date.now() - ceiling * 3_600_000);

    const stale = await prisma.timeEntry.findMany({
      where: {
        source: "TIMER",
        endedAt: null,
        deletedAt: null,
        isSuspended: false,
        startedAt: { lt: cutoff },
      },
      select: {
        startedAt: true,
        user: { select: { name: true } },
        task: { select: { displayKey: true } },
      },
    });

    console.log(`[watchdog] DRY RUN — ceiling ${ceiling}h, nothing will be written.`);
    console.log(`[watchdog] ${stale.length} timer(s) would be suspended:`);
    for (const e of stale) {
      const hours = ((Date.now() - e.startedAt!.getTime()) / 3_600_000).toFixed(1);
      console.log(`  ${e.task.displayKey}  ${e.user.name}  running ${hours}h`);
    }
    return;
  }

  const { suspended, ceilingHours } = await runTimerWatchdog();

  if (suspended.length === 0) {
    console.log(
      `[watchdog] No timers past ${ceilingHours}h. (${Date.now() - startedAt}ms)`
    );
    return;
  }

  // Logged per entry rather than as a count, because the useful question when
  // someone asks "why does my timesheet say nothing was recorded" is which
  // timer, whose, and from when.
  console.log(`[watchdog] Suspended ${suspended.length} timer(s) past ${ceilingHours}h:`);
  for (const s of suspended) {
    console.log(
      `  ${s.taskKey}  ${s.userName}  started ${s.startedAt.toISOString()}  ran ${s.elapsedHours}h`
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    // Loud and non-zero: a watchdog that fails silently is worse than none,
    // because the absence of suspended timers looks identical to success.
    console.error("[watchdog] FAILED:", e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
