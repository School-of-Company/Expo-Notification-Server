import { z } from 'zod';

const phoneNumber = z.string().regex(/^01\d{8,9}$/);
const senderType = z.enum(['STANDARD', 'TRAINEE']);

const base = {
  eventId: z.string().min(1),
  version: z.literal(1),
};

export const smsEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('QR_ISSUED'),
    phoneNumber,
    senderType,
    expoName: z.string().min(1),
    qrUrl: z.url(),
    contactNumber: z.string().min(1).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('SURVEY_REQUESTED'),
    phoneNumber,
    senderType,
    expoName: z.string().min(1),
    surveyUrl: z.url(),
  }),
  z.object({
    ...base,
    type: z.literal('DRAW_RESULT'),
    phoneNumber,
    drawNumber: z.number().int().nonnegative(),
  }),
  z.object({
    ...base,
    type: z.literal('CUSTOM'),
    phoneNumbers: z.array(phoneNumber).min(1).max(1000),
    senderType,
    text: z.string().min(1).max(2000),
  }),
]);

export type SmsEvent = z.infer<typeof smsEventSchema>;
export type SenderType = z.infer<typeof senderType>;
