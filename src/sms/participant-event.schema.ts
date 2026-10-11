import { z } from 'zod';
import {
  normalizedPhoneNumber,
  participationTypeSchema,
} from './participation-type';

const participantEvent = z.object({
  eventId: z.string().min(1),
  expoId: z.string().min(1),
  participationType: participationTypeSchema,
  id: z.number().int().nonnegative(),
  phoneNumber: normalizedPhoneNumber,
});

/** User 서비스가 등록 완료(QR 문자 발송 대상) 때 아웃박스로 발행한다. 연수 사전등록은 발행하지 않는다. */
export const participantRegisteredSchema = participantEvent.extend({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  representativeId: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  participants: z
    .array(
      z.object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]{22}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(5)
    .refine(
      (participants) =>
        new Set(participants.map(({ id }) => id)).size === participants.length,
      'duplicate participant IDs',
    )
    .optional(),
});
export type ParticipantRegisteredEvent = z.infer<
  typeof participantRegisteredSchema
>;

/** Attention 서비스가 일반 참가자 입장 때 아웃박스로 발행한다. */
export const entryRecordedSchema = participantEvent;
export type EntryRecordedEvent = z.infer<typeof entryRecordedSchema>;
