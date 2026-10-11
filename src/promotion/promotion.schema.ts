import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);

export const promotionEventSchema = z.object({
  version: z.literal(1),
  eventId: z.uuid(),
  applicationId: z.uuid(),
  expoId: z.uuid(),
  participantId: id,
  programType: z.enum(['STANDARD', 'TRAINING']),
  programId: id,
});
export type PromotionEvent = z.infer<typeof promotionEventSchema>;

export const promotionCheckSchema = z.discriminatedUnion('eligible', [
  z.object({
    eligible: z.literal(false),
    reason: z.enum(['CANCELLED', 'REPLACED', 'NOT_CURRENT_PROMOTION']),
  }),
  z
    .object({
      eligible: z.literal(true),
      eventId: z.uuid(),
      applicationId: z.uuid(),
      expoId: z.uuid(),
      participantId: id,
      programType: z.enum(['STANDARD', 'TRAINING']),
      programId: id,
      status: z.literal('CONFIRMED'),
      representativePhoneNumber: z
        .string()
        .regex(/^0\d{8,10}$/)
        .nullable(),
      participantName: label,
      programName: label,
      startedAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }),
      location: label.nullable(),
      applicationLookupUrl: z
        .url()
        .max(500)
        .refine((url) => new URL(url).protocol === 'https:')
        .nullable(),
    })
    .refine((value) => Date.parse(value.endedAt) > Date.parse(value.startedAt)),
]);
export type PromotionCheck = z.infer<typeof promotionCheckSchema>;

export const promotionRecordSchema = z.object({
  event: promotionEventSchema,
  status: z.enum([
    'PENDING',
    'SENDING',
    'UNKNOWN',
    'ACCEPTED',
    'DELIVERED',
    'SKIPPED',
    'OPERATIONS',
  ]),
  failures: z.number().int().nonnegative(),
  attemptId: z.uuid().optional(),
  attemptedAt: z.iso.datetime().optional(),
  groupId: z.string().optional(),
  messageId: z.string().optional(),
  providerCode: z.string().optional(),
  reason: z.string().optional(),
});
export type PromotionRecord = z.infer<typeof promotionRecordSchema>;

export class PromotionRetryError extends Error {
  constructor() {
    super('promotion retry required');
  }
}
