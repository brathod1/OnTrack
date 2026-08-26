import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma instance.
 *
 * Next.js dev mode hot-reloads modules on every edit; without the global cache
 * each reload opens a new connection pool and Postgres runs out of slots
 * within a few minutes of editing.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Log levels by environment.
 *
 * Tests are silent by design. Much of the suite deliberately provokes
 * constraint violations — a second timer, an overlapping session, an app-role
 * write to the activity log — and Prisma logs each one as a multi-line error
 * block. Twenty such blocks for a passing run buries the one that matters when
 * something genuinely breaks. Vitest sets NODE_ENV=test automatically.
 */
function logLevels(): ("query" | "warn" | "error")[] {
  switch (process.env.NODE_ENV) {
    case "test":
      return [];
    case "development":
      return ["query", "warn", "error"];
    default:
      return ["warn", "error"];
  }
}

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: logLevels() });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * BigInt ids do not survive JSON.stringify. Rather than scattering .toString()
 * through every route handler, serialise once at the boundary.
 */
export function serialise<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}
