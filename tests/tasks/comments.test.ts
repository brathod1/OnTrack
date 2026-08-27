/**
 * Comments.
 *
 * The rules worth pinning are the ones that protect the work record: an
 * author's edit window, who may remove a comment, and that removal leaves a
 * tombstone rather than a hole. A firm may read this discussion back months
 * later, possibly to settle a disagreement, and "someone deleted something"
 * is a materially different answer from silence.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "../helpers/db";
import { buildFirm, type Firm } from "../helpers/fixtures";
import { loadActingUser, type ActingUser } from "@/lib/auth/permissions";
import { ForbiddenError, InvalidOperationError, NotFoundError } from "@/lib/errors";
import {
  EDIT_WINDOW_MINUTES,
  addComment,
  deleteComment,
  editComment,
  getMentionableUsers,
  isEditable,
  listComments,
} from "@/lib/tasks/comments";

let firm: Firm;
const actor: Record<string, ActingUser> = {};

beforeEach(async () => {
  await resetDatabase();
  firm = await buildFirm();
  for (const [name, id] of Object.entries(firm.users)) {
    actor[name] = await loadActingUser(id);
  }
});

/** Backdate a comment so the edit window can be tested without waiting. */
async function ageComment(id: bigint, minutes: number) {
  await prisma.comment.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - minutes * 60_000) },
  });
}

describe("posting", () => {
  it("anyone who can see the task may comment", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "Vendor invoices are still missing.",
    });
    expect(c.author.id).toBe(firm.users.eshan);
  });

  it("refuses a comment on a task the user cannot see", async () => {
    // Chandra has no relationship to anything, so the task is not found —
    // the same answer she gets for a task that does not exist.
    await expect(
      addComment(actor.chandra!, firm.tasks.t1, { bodyMd: "hello" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an empty comment", async () => {
    await expect(
      addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "   " })
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("records the comment in the activity log", async () => {
    await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Noted." });
    const entries = await prisma.activityLog.findMany({
      where: { taskId: firm.tasks.t1, action: "COMMENT_ADDED" },
    });
    expect(entries).toHaveLength(1);
  });
});

describe("mentions", () => {
  it("keeps mentions of people who can see the task", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "@Meera Manager please look",
      mentions: [firm.users.meera],
    });
    expect(c.mentions.map(String)).toContain(firm.users.meera.toString());
  });

  it("DROPS mentions of people who cannot", async () => {
    // Otherwise a crafted request notifies someone about work they are not
    // permitted to open — an invitation to a room with no key.
    const c = await addComment(actor.eshan!, firm.tasks.t1, {
      bodyMd: "@Chandra look at this",
      mentions: [firm.users.chandra],
    });
    expect(c.mentions).toHaveLength(0);
  });

  it("offers only people with a relationship to the task", async () => {
    const people = await getMentionableUsers(actor.eshan!, firm.tasks.t1);
    const ids = people.map((p) => p.id.toString());

    expect(ids).toContain(firm.users.eshan.toString()); // assignee
    expect(ids).toContain(firm.users.meera.toString()); // engagement manager
    expect(ids).not.toContain(firm.users.chandra.toString()); // unrelated
  });
});

describe("the edit window", () => {
  it("lets an author fix their own comment straight away", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Typo herre" });
    const fixed = await editComment(actor.eshan!, c.id, "Typo here");

    expect(fixed.bodyMd).toBe("Typo here");
    expect(fixed.editedAt).not.toBeNull();
  });

  it("closes after the window, so the record cannot be quietly rewritten", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Original" });
    await ageComment(c.id, EDIT_WINDOW_MINUTES + 1);

    await expect(
      editComment(actor.eshan!, c.id, "Rewritten after the fact")
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it("never lets anyone edit someone else's words", async () => {
    // Not even a manager. A record where a manager can rewrite what a junior
    // said is untrustworthy in exactly the situation it exists for.
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "My words" });

    await expect(
      editComment(actor.meera!, c.id, "Words put in his mouth")
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps the original text in the activity log", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Before" });
    await editComment(actor.eshan!, c.id, "After");

    const entry = await prisma.activityLog.findFirst({
      where: { taskId: firm.tasks.t1, action: "COMMENT_EDITED" },
    });
    // An edit supersedes; it does not erase.
    expect(entry?.oldValue).toBe("Before");
    expect(entry?.newValue).toBe("After");
  });

  it("isEditable agrees with the service", async () => {
    const fresh = { createdAt: new Date(), deletedAt: null };
    const stale = {
      createdAt: new Date(Date.now() - (EDIT_WINDOW_MINUTES + 1) * 60_000),
      deletedAt: null,
    };

    expect(isEditable(fresh, firm.users.eshan, firm.users.eshan)).toBe(true);
    expect(isEditable(stale, firm.users.eshan, firm.users.eshan)).toBe(false);
    expect(isEditable(fresh, firm.users.eshan, firm.users.meera)).toBe(false);
  });
});

describe("removal leaves a tombstone", () => {
  it("an author may remove their own comment", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Never mind" });
    const removed = await deleteComment(actor.eshan!, c.id);
    expect(removed.deletedAt).not.toBeNull();
  });

  it("the row survives — the page shows 'removed', not silence", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Contentious" });
    await deleteComment(actor.eshan!, c.id);

    const all = await listComments(actor.eshan!, firm.tasks.t1);
    expect(all).toHaveLength(1);
    expect(all[0]?.deletedAt).not.toBeNull();
  });

  it("the original text is preserved in the activity log", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Said in haste" });
    await deleteComment(actor.eshan!, c.id);

    const entry = await prisma.activityLog.findFirst({
      where: { taskId: firm.tasks.t1, action: "COMMENT_DELETED" },
    });
    expect(entry?.oldValue).toBe("Said in haste");
  });

  it("a manager may remove someone else's", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Inappropriate" });
    await expect(deleteComment(actor.meera!, c.id)).resolves.toBeDefined();
  });

  it("someone who can see the task but neither wrote it nor manages it may not", async () => {
    // Meera writes it; Eshan is the assignee and an engagement member, so he
    // can certainly SEE the comment — he just has no standing to remove it.
    const c = await addComment(actor.meera!, firm.tasks.t1, { bodyMd: "Manager's note" });
    await expect(deleteComment(actor.eshan!, c.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("someone who cannot see the task gets 404, not 403", async () => {
    // The distinction matters. Esha is on a different engagement, so the task
    // is simply not found for her — telling her "forbidden" would confirm a
    // comment exists on work she has no business knowing about.
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Mine" });
    await expect(deleteComment(actor.esha!, c.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removing twice is harmless", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Gone" });
    await deleteComment(actor.eshan!, c.id);
    await expect(deleteComment(actor.eshan!, c.id)).resolves.toBeDefined();
  });

  it("a removed comment cannot be edited back into existence", async () => {
    const c = await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "Gone" });
    await deleteComment(actor.eshan!, c.id);

    await expect(
      editComment(actor.eshan!, c.id, "Back again")
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe("ordering", () => {
  it("reads oldest first, like a conversation", async () => {
    await addComment(actor.eshan!, firm.tasks.t1, { bodyMd: "First" });
    await addComment(actor.meera!, firm.tasks.t1, { bodyMd: "Second" });

    const all = await listComments(actor.eshan!, firm.tasks.t1);
    expect(all.map((c) => c.bodyMd)).toEqual(["First", "Second"]);
  });
});
