import { z } from "zod";
import { dateOnlySchema, idSchema } from "@/lib/tasks/schemas";
import { DurationParseError, parseDuration } from "./duration";

/**
 * Input validation for time entry.
 *
 * The duration field accepts what a person types and converts it to minutes
 * here, once, at the boundary. Everything downstream — service, database,
 * reports — deals only in whole minutes and never sees "1h 30m".
 */

/** "1h 30m", "1:30", "90m", "1.5" → 90. Rejects anything it cannot read. */
export const durationSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    try {
      return parseDuration(raw);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof DurationParseError ? e.message : "not a length of time",
      });
      return z.NEVER;
    }
  });

export const startTimerSchema = z.object({
  taskId: idSchema,
});

export const stopTimerSchema = z.object({
  /** Required by the service past eight hours; optional as far as shape goes. */
  note: z.string().trim().max(2000).optional(),
  /** What the page believed. The service refuses if the timer has moved on. */
  expectedTaskId: idSchema.optional(),
});

export const discardTimerSchema = z.object({
  reason: z.string().trim().min(3, "say why you are discarding it").max(500),
  expectedTaskId: idSchema.optional(),
});

export const logTimeSchema = z.object({
  taskId: idSchema,
  workDate: dateOnlySchema,
  duration: durationSchema,
  note: z.string().trim().max(2000).optional(),
});

export type LogTimeInput = z.infer<typeof logTimeSchema>;

export const editTimeSchema = z.object({
  entryId: idSchema,
  duration: durationSchema,
  note: z.string().trim().max(2000).optional(),
  /** The service requires this when the entry belongs to someone else. */
  reason: z.string().trim().max(500).optional(),
});

export const deleteTimeSchema = z.object({
  entryId: idSchema,
  reason: z.string().trim().max(500).optional(),
});

/** The week a timesheet grid is showing. Absent means the current week. */
export const timesheetWeekSchema = z.object({
  weekStart: dateOnlySchema.optional(),
  /** Managers viewing someone they oversee; the service still checks standing. */
  userId: idSchema.optional(),
});
