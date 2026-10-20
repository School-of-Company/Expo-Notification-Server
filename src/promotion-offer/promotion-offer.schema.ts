import { z } from 'zod';

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);

// Application `application.promotion-offer.requested` v1. Not the completed-promotion event: an offer asks the
// representative to respond, and sending it never confirms anything.
export const promotionOfferEventSchema = z.object({
  version: z.literal(1),
  eventId: z.uuid(),
  offerId: z.uuid(),
  expoId: z.uuid(),
});
export type PromotionOfferEvent = z.infer<typeof promotionOfferEventSchema>;

export const promotionOfferCheckSchema = z.discriminatedUnion('eligible', [
  z.object({
    eligible: z.literal(false),
    reason: z.enum(['NOT_CURRENT_OFFER', 'OUTSIDE_SEND_WINDOW']),
  }),
  z
    .object({
      eligible: z.literal(true),
      eventId: z.uuid(),
      offerId: z.uuid(),
      expoId: z.uuid(),
      target: z.enum(['PROGRAM', 'PREREGISTER']),
      representativePhoneNumber: z
        .string()
        .regex(/^0\d{8,10}$/)
        .nullable(),
      recipientName: label(100),
      title: label(100),
      startedAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }),
      location: label(255).nullable(),
      seats: z.number().int().min(1).max(100),
      responseUrl: z
        .url()
        .max(500)
        .refine((url) => new URL(url).protocol === 'https:'),
      hardDeadline: z.iso.datetime({ offset: true }),
      sendWindowEndsAt: z.iso.datetime({ offset: true }),
      responseHours: z.number().int().min(1).max(24),
    })
    .refine((value) => Date.parse(value.endedAt) > Date.parse(value.startedAt)),
]);
export type PromotionOfferCheck = z.infer<typeof promotionOfferCheckSchema>;

export const promotionOfferReportStatus = z.enum([
  'ACCEPTED',
  'DELIVERED',
  'FAILED',
  'UNKNOWN',
  'SKIPPED',
]);
export type PromotionOfferReportStatus = z.infer<
  typeof promotionOfferReportStatus
>;

export const promotionOfferRecordSchema = z.object({
  event: promotionOfferEventSchema,
  status: z.enum([
    'PENDING',
    'SENDING',
    'UNKNOWN',
    'ACCEPTED',
    'DELIVERED',
    'FAILED',
    'SKIPPED',
  ]),
  failures: z.number().int().nonnegative(),
  attemptId: z.uuid().optional(),
  attemptedAt: z.iso.datetime().optional(),
  // When the provider's success response was received; never copied from attemptedAt.
  acceptedAt: z.iso.datetime().optional(),
  groupId: z.string().optional(),
  messageId: z.string().optional(),
  providerCode: z.string().optional(),
  reason: z.string().optional(),
  // Result still owed to Application; retried until Application records it.
  report: promotionOfferReportStatus.optional(),
});
export type PromotionOfferRecord = z.infer<typeof promotionOfferRecordSchema>;

// Well past the 30s claim and 10s provider timeout, so only an abandoned attempt is still SENDING by then.
export const promotionOfferSendingStaleMs = 5 * 60_000;

export class PromotionOfferRetryError extends Error {
  constructor() {
    super('promotion offer retry required');
  }
}

// A response that breaks the check contract repeats on every lookup; retrying it only holds the seats.
export class PromotionOfferInvalidCheckError extends Error {
  constructor() {
    super('promotion offer check response invalid');
  }
}
