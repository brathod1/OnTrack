import { z } from "zod";
import { DueDateType, Priority, TaskStatus } from "@prisma/client";

/**
 * Input validation for every task mutation.
 *
 * Validation runs at the API boundary, before authorisation and before any
 * database access. Two reasons for that order: a malformed request should
 * never reach a permission check that might load rows on its behalf, and the
 * error a caller gets should say "this field is wrong", not "forbidden",
 * which would be misleading.
 */

/** JSON has no BigInt. Ids arrive as strings and are parsed here, once. */
export const idSchema = z
  .string()
  .regex(/^\d+$/, "must be a numeric id")
  .transform((v) => BigInt(v));

/**
 * A calendar date, not an instant.
 *
 * Accepts "2026-09-30" and pins it to UTC midnight. Taking a full timestamp
 * here would let a browser in a different zone shift a due date by a day —
 * the exact class of bug the schema's date/timestamptz split exists to avoid.
 */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), "not a valid date");

/** Minutes, always. Capped at 200 hours — beyond that it is an engagement. */
const estimateSchema = z
  .number()
  .int("must be whole minutes")
  .min(0)
  .max(200 * 60, "an estimate over 200 hours should be split into subtasks");

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(3, "give the task a title").max(200),
    description: z.string().trim().max(20_000).optional(),

    engagementId: idSchema,
    assigneeId: idSchema,
    parentTaskId: idSchema.optional(),

    dueDate: dateOnlySchema,
    dueDateType: z.nativeEnum(DueDateType).default(DueDateType.INTERNAL),
    statutoryDueDate: dateOnlySchema.optional(),

    priority: z.nativeEnum(Priority).default(Priority.NORMAL),

    reviewRequired: z.boolean().optional(),
    reviewerId: idSchema.optional(),

    estimateMinutes: estimateSchema.optional(),
    tagIds: z.array(idSchema).max(10).optional(),
  })
  .refine((v) => !v.reviewerId || v.reviewerId !== v.assigneeId, {
    message: "a task cannot be reviewed by the person doing it",
    path: ["reviewerId"],
  })
  .refine((v) => !v.statutoryDueDate || v.dueDate <= v.statutoryDueDate, {
    message: "the due date cannot be later than the statutory deadline",
    path: ["dueDate"],
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * Field updates. Every key optional — a PATCH may carry one field.
 *
 * `expectedVersion` is the optimistic lock: the `updatedAt` the client last
 * saw. Required, deliberately. Making it optional means the one caller who
 * forgets it silently gets last-write-wins, which is precisely the behaviour
 * the lock exists to prevent.
 */
export const updateTaskSchema = z.object({
  expectedVersion: z.string().datetime({ offset: true }),

  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  priority: z.nativeEnum(Priority).optional(),
  dueDate: dateOnlySchema.optional(),
  dueDateType: z.nativeEnum(DueDateType).optional(),
  statutoryDueDate: dateOnlySchema.nullable().optional(),
  reviewerId: idSchema.nullable().optional(),
  reviewRequired: z.boolean().optional(),
  currentEstimateMinutes: estimateSchema.nullable().optional(),

  /** Required whenever a deadline moves — the activity log demands a why. */
  reason: z.string().trim().min(3).max(500).optional(),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const assignTaskSchema = z.object({
  expectedVersion: z.string().datetime({ offset: true }),
  assigneeId: idSchema,
  reason: z.string().trim().max(500).optional(),
});

export const transitionSchema = z.object({
  expectedVersion: z.string().datetime({ offset: true }),
  to: z.nativeEnum(TaskStatus),
  reason: z.string().trim().max(500).optional(),
  /** Manager-only: proceed despite open subtasks. Requires a reason. */
  override: z.boolean().optional(),
});

export const blockSchema = z.object({
  expectedVersion: z.string().datetime({ offset: true }),
  blocked: z.boolean(),
  // A blocked flag with no reason is noise nobody can act on, and the database
  // rejects it anyway — better to fail here with a useful message.
  reason: z.string().trim().min(3, "say what is blocking it").max(500).optional(),
  expectedUnblockDate: dateOnlySchema.optional(),
}).refine((v) => !v.blocked || Boolean(v.reason), {
  message: "say what is blocking it",
  path: ["reason"],
});

export const contributorSchema = z.object({
  userId: idSchema,
});

/** Filters for the task list. Everything optional; all combinable. */
export const listTasksSchema = z.object({
  clientId: idSchema.optional(),
  engagementId: idSchema.optional(),
  assigneeId: idSchema.optional(),
  assignedById: idSchema.optional(),
  reviewerId: idSchema.optional(),
  status: z.array(z.nativeEnum(TaskStatus)).optional(),
  priority: z.array(z.nativeEnum(Priority)).optional(),
  dueDateType: z.array(z.nativeEnum(DueDateType)).optional(),
  blocked: z.boolean().optional(),
  overdue: z.boolean().optional(),
  dueBefore: dateOnlySchema.optional(),
  dueAfter: dateOnlySchema.optional(),
  tagIds: z.array(idSchema).optional(),
  hasEstimate: z.boolean().optional(),
  search: z.string().trim().min(2).max(200).optional(),

  cursor: idSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type ListTasksInput = z.infer<typeof listTasksSchema>;
