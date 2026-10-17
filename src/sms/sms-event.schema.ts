import { z } from 'zod';
import { expoIdSchema } from '../common/expo-name.provider';

const phoneNumber = z.string().regex(/^01\d{8,9}$/);
const senderType = z.enum(['STANDARD', 'TRAINEE']);

const base = {
  eventId: z.string().min(1),
  version: z.literal(1),
};

export const smsEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('DRAW_RESULT'),
    phoneNumber,
    drawNumber: z.number().int().nonnegative(),
    // K4 문구에는 행사명이 없어 아직 쓰지 않는다. Form이 보내도 거절하지 않도록 받는다.
    expoId: expoIdSchema.optional(),
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
