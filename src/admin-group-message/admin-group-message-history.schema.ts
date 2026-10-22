import { z } from 'zod';

export const groupMessageHistoryTypeSchema = z.enum([
  'REQUESTED',
  'SENT',
  'FAILED',
  'RETRIED',
]);

export type GroupMessageHistoryType = z.infer<
  typeof groupMessageHistoryTypeSchema
>;

export const groupMessageHistoryEventSchema = z
  .object({
    eventId: z.uuid(),
    type: groupMessageHistoryTypeSchema,
    adminId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurredAt: z.iso.datetime(),
    targetScope: z.object({
      kind: z.literal('EXPLICIT_TARGETS'),
      applicationCount: z.number().int().positive().nullable(),
      programTypes: z.array(z.enum(['STANDARD', 'TRAINING'])),
      source: z.literal('PREREGISTRATION').optional(),
    }),
    counts: z.object({
      total: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
    }),
    status: z.enum([
      'QUEUED',
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'COMPLETED_WITH_FAILURES',
      'ATTENTION',
    ]),
    jobId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type GroupMessageHistoryEvent = z.infer<
  typeof groupMessageHistoryEventSchema
>;

export const groupMessageHistoryQuerySchema = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    type: groupMessageHistoryTypeSchema.optional(),
    cursor: z
      .string()
      .regex(
        /^\d{13}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type GroupMessageHistoryQuery = z.infer<
  typeof groupMessageHistoryQuerySchema
>;
