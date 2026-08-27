"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addCommentAction,
  deleteCommentAction,
  editCommentAction,
  type ActionResult,
} from "@/app/(app)/tasks/[key]/actions";

/**
 * Task discussion.
 *
 * Flat and chronological — a conversation, unlike the activity timeline above
 * it, where the most recent change is what people arrive looking for.
 *
 * Mentions are PICKED, never parsed. A dropdown inserts the name into the text
 * and records the id separately. Parsing "@Kavya" out of prose breaks the
 * moment two people share a first name, and it fails silently by notifying the
 * wrong person rather than erroring.
 */

export interface CommentView {
  id: string;
  bodyMd: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface MentionablePerson {
  id: string;
  name: string;
}

export function TaskComments({
  taskKey,
  comments,
  mentionable,
  currentUserId,
}: {
  taskKey: string;
  comments: CommentView[];
  mentionable: MentionablePerson[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    addCommentAction,
    null
  );

  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [mentioned, setMentioned] = useState<MentionablePerson[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (state?.ok && formRef.current) {
      formRef.current.reset();
      setMentioned([]);
      setShowPicker(false);
      router.refresh();
    }
  }, [state, router]);

  function mention(person: MentionablePerson) {
    if (!mentioned.some((m) => m.id === person.id)) {
      setMentioned((m) => [...m, person]);
    }
    const box = bodyRef.current;
    if (box) {
      const needsSpace = box.value.length > 0 && !box.value.endsWith(" ");
      box.value = `${box.value}${needsSpace ? " " : ""}@${person.name} `;
      box.focus();
    }
    setShowPicker(false);
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">
        Discussion
        {comments.length > 0 && (
          <span className="tabular ml-2 text-xs font-normal text-slate-400">
            {comments.filter((c) => !c.deletedAt).length}
          </span>
        )}
      </h2>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {comments.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">
            No comments yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {comments.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                taskKey={taskKey}
                isEditing={editingId === c.id}
                onEdit={() => setEditingId(c.id)}
                onCancelEdit={() => setEditingId(null)}
                currentUserId={currentUserId}
              />
            ))}
          </ul>
        )}

        {/* ── New comment ─────────────────────────────────────────────── */}
        <form ref={formRef} action={formAction} className="border-t border-slate-200 p-3">
          <input type="hidden" name="key" value={taskKey} />
          <input
            type="hidden"
            name="mentions"
            value={mentioned.map((m) => m.id).join(",")}
          />

          <textarea
            ref={bodyRef}
            name="body"
            required
            rows={3}
            placeholder="Add a comment…"
            className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />

          {mentioned.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Notifying: {mentioned.map((m) => m.name).join(", ")}
              <button
                type="button"
                onClick={() => setMentioned([])}
                className="ml-2 underline hover:text-slate-800"
              >
                clear
              </button>
            </p>
          )}

          {state && !state.ok && state.error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {state.error}
            </p>
          )}

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowPicker((v) => !v)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
              >
                @ Mention
              </button>

              {showPicker && (
                <div className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-56 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
                  {/*
                    Only people with a relationship to this task. Offering the
                    whole firm would let a mention summon someone who then
                    cannot open the task they were called to.
                  */}
                  {mentionable.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-500">Nobody to mention.</p>
                  ) : (
                    mentionable.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => mention(p)}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                      >
                        {p.name}
                        {p.id === currentUserId && (
                          <span className="ml-1 text-xs text-slate-400">(you)</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-slate-400 sm:inline">
                Ctrl + Enter to post
              </span>
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {pending ? "Posting…" : "Comment"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  taskKey,
  isEditing,
  onEdit,
  onCancelEdit,
}: {
  comment: CommentView;
  taskKey: string;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  currentUserId: string;
}) {
  const router = useRouter();
  const [editState, editAction, editPending] = useActionState<ActionResult | null, FormData>(
    editCommentAction,
    null
  );
  const [deleteState, deleteAction, deletePending] = useActionState<
    ActionResult | null,
    FormData
  >(deleteCommentAction, null);

  useEffect(() => {
    if (editState?.ok || deleteState?.ok) {
      onCancelEdit();
      router.refresh();
    }
  }, [editState, deleteState, onCancelEdit, router]);

  // A tombstone, not a disappearance. Comments are part of the work record,
  // and one vanishing without trace is worse than one marked as removed.
  if (comment.deletedAt) {
    return (
      <li className="px-4 py-3 text-sm italic text-slate-400">
        Comment removed
      </li>
    );
  }

  const when = new Date(comment.createdAt);

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-slate-900">{comment.authorName}</span>
          <span className="text-xs text-slate-400">
            {when.toLocaleString("en-GB", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {comment.editedAt && (
            <span className="text-xs text-slate-400" title="Edited within 15 minutes of posting">
              edited
            </span>
          )}
        </div>

        <div className="flex gap-2 text-xs">
          {comment.canEdit && !isEditing && (
            <button onClick={onEdit} className="text-slate-500 hover:text-slate-900">
              Edit
            </button>
          )}
          {comment.canDelete && (
            <form action={deleteAction} className="inline">
              <input type="hidden" name="key" value={taskKey} />
              <input type="hidden" name="commentId" value={comment.id} />
              <button
                type="submit"
                disabled={deletePending}
                className="text-slate-500 hover:text-red-700 disabled:opacity-50"
              >
                Remove
              </button>
            </form>
          )}
        </div>
      </div>

      {isEditing ? (
        <form action={editAction} className="mt-2">
          <input type="hidden" name="key" value={taskKey} />
          <input type="hidden" name="commentId" value={comment.id} />
          <textarea
            name="body"
            required
            rows={3}
            defaultValue={comment.bodyMd}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {editState && !editState.ok && editState.error && (
            <p role="alert" className="mt-1 text-sm text-red-700">
              {editState.error}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={editPending}
              className="rounded-md bg-slate-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{comment.bodyMd}</p>
      )}
    </li>
  );
}
