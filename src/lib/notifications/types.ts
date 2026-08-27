/**
 * The shape a notification takes once it has crossed to the browser.
 *
 * Lives here rather than beside either consumer because both a server action
 * and two client components need it. Declared in the client component, the
 * dependency ran backwards — a "use server" file importing from a "use client"
 * one — which happens to erase at compile but points the wrong way and would
 * eventually import something that does not erase.
 *
 * Everything is a string. BigInt does not survive the boundary, and Date
 * arrives as an ISO string that then has to be formatted somewhere; both are
 * resolved on the server, where the organisation's date format lives.
 */
export interface NotificationRow {
  id: string;
  taskKey: string | null;
  taskTitle: string | null;
  clientName: string | null;
  /** The bold half — what happened. */
  headline: string;
  /** The quieter half — reason, excerpt, or dates. Often absent. */
  detail: string | null;
  tone: "neutral" | "attention" | "warning";
  /** Already rendered: "3m ago", "yesterday", "12 Aug". */
  ago: string;
  read: boolean;
}
