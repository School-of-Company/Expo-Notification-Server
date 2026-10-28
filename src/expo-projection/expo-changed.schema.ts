import { z } from 'zod';
import { expoIdSchema } from '../common/expo-internal-api';

/** Expo가 지금 보내는 형식. 의미가 바뀌면 올라가므로 모르는 버전은 반영하지 않는다. */
export const SUPPORTED_SCHEMA_VERSION = 1;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const envelope = {
  schemaVersion: z.number().int(),
  eventId: z.string().min(1),
  version: z.number().int().nonnegative(),
  expoId: expoIdSchema,
};

// 이 서버가 읽는 필드만 받는다. 나머지(프로그램, 설명 등)는 zod가 버린다.
export const expoChangedEventSchema = z.discriminatedUnion('deleted', [
  z.object({ ...envelope, deleted: z.literal(true) }),
  z.object({
    ...envelope,
    deleted: z.literal(false),
    expo: z.object({
      title: z.string(),
      startedDay: day,
      finishedDay: day,
      deleting: z.boolean(),
    }),
    preregisterSessions: z.array(
      z.object({ id: z.number().int(), title: z.string() }),
    ),
  }),
]);

export type ExpoChangedEvent = z.infer<typeof expoChangedEventSchema>;

/** Redis에 저장하는 박람회 한 건. */
export const projectedExpoSchema = z.object({
  expoId: expoIdSchema,
  title: z.string(),
  startedDay: day,
  finishedDay: day,
  deleting: z.boolean(),
  sessions: z.array(z.object({ id: z.number().int(), title: z.string() })),
});

export type ProjectedExpo = z.infer<typeof projectedExpoSchema>;
