import { z } from 'zod';
import { expoIdSchema } from '../common/expo-internal-api';

const phoneNumber = z.string().regex(/^01\d{8,9}$/);
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);
const dateTime = z.iso.datetime({ offset: true });

// 프로그램명이나 사전등록 회차명. 프로그램·교원연수 신청은 프로그램 회차, 사전등록은 등록 회차를 담는다.
const item = z
  .object({
    participantName: label(100),
    title: label(100),
    startedAt: dateTime.optional(),
    endedAt: dateTime.optional(),
    location: label(255).nullable().optional(),
  })
  .refine(
    (value) =>
      (value.startedAt === undefined) === (value.endedAt === undefined),
    { message: 'startedAt and endedAt must be given together' },
  )
  .refine(
    (value) =>
      value.startedAt === undefined ||
      Date.parse(value.endedAt!) > Date.parse(value.startedAt),
    { message: 'endedAt must be after startedAt' },
  );

const items = z.array(item).min(1).max(10);

const base = {
  eventId: z.string().min(1),
  version: z.literal(1),
  // 대표자 번호. 학생 개인 번호로 대신하지 않는다.
  phoneNumber,
  expoId: expoIdSchema,
  senderType: z.enum(['STANDARD', 'TRAINEE']).default('STANDARD'),
  // 상태가 바뀐 시각. 너무 오래된 이벤트는 소급 발송하지 않으려고 버린다.
  occurredAt: dateTime,
  applicationUrl: z
    .url()
    .max(500)
    .refine((url) => new URL(url).protocol === 'https:')
    .nullable()
    .optional(),
};
const cancelledBy = z.enum(['USER', 'ADMIN']);

export const applicationResultEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('PROGRAM_CONFIRMED'), items }),
  z.object({ ...base, type: z.literal('PROGRAM_WAITLISTED'), items }),
  z.object({
    ...base,
    type: z.literal('PROGRAM_CANCELLED'),
    cancelledBy,
    items,
  }),
  z.object({
    ...base,
    type: z.literal('PREREGISTER_CANCELLED'),
    cancelledBy,
    // PARTIAL이면 목록에 없는 등록은 유지된다고 안내한다.
    scope: z.enum(['ALL', 'PARTIAL']),
    items,
  }),
  z.object({
    ...base,
    type: z.literal('PREREGISTER_SESSION_ADDED'),
    // 회차마다 최종 결과가 다를 수 있다.
    items: z
      .array(
        item.and(z.object({ result: z.enum(['CONFIRMED', 'WAITLISTED']) })),
      )
      .min(1)
      .max(10),
  }),
  z.object({ ...base, type: z.literal('OFFER_EXPIRED'), items }),
]);

export type ApplicationResultEvent = z.infer<
  typeof applicationResultEventSchema
>;
export type ApplicationResultType = ApplicationResultEvent['type'];
