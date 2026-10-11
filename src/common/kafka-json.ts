import { KafkaMessage } from 'kafkajs';
import { ZodType } from 'zod';

export type ParsedMessage<T> =
  { ok: true; value: T } | { ok: false; reason: string };

export function parseKafkaJson<T>(
  message: KafkaMessage,
  schema: ZodType<T>,
): ParsedMessage<T> {
  if (!message.value) {
    return { ok: false, reason: 'empty message value' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(message.value.toString());
  } catch {
    return { ok: false, reason: 'message is not valid JSON' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
  return { ok: true, value: result.data };
}
