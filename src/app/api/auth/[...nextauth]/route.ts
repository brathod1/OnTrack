import { handlers } from "@/lib/auth/auth";

/**
 * The Auth.js endpoint: /api/auth/signin, /callback, /signout, /session.
 *
 * Explicitly the Node.js runtime, not Edge — the sign-in callback reads and
 * writes users through Prisma.
 */
export const runtime = "nodejs";

export const { GET, POST } = handlers;
