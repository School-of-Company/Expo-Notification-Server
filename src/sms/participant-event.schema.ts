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
export const participantRegisteredSchema = participantEvent;
export type ParticipantRegisteredEvent = z.infer<
  typeof participantRegisteredSchema
>;

/** Attention 서비스가 일반 참가자 입장 때 아웃박스로 발행한다. */
export const entryRecordedSchema = participantEvent;
export type EntryRecordedEvent = z.infer<typeof entryRecordedSchema>;
