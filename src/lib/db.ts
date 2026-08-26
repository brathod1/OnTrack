import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma instance.
 *
 * Next.js dev mode hot-reloads modules on every edit; without the global cache
 * each reload opens a new connection pool and Postgres runs out of slots
 * within a few minutes of editing.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });

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
