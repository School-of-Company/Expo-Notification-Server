import { KafkaMessage } from 'kafkajs';
import { z } from 'zod';
import { parseKafkaJson } from './kafka-json';

const schema = z.object({ id: z.string() });
const message = (value: string | null) =>
  ({ value: value === null ? null : Buffer.from(value) }) as KafkaMessage;

describe('parseKafkaJson', () => {
  it('유효한 JSON은 스키마로 파싱한다', () => {
    expect(parseKafkaJson(message('{"id":"a"}'), schema)).toEqual({
      ok: true,
      value: { id: 'a' },
    });
  });

  it('value가 없으면 실패로 반환한다', () => {
    expect(parseKafkaJson(message(null), schema)).toEqual({
      ok: false,
      reason: 'empty message value',
    });
  });

  it('JSON이 아니면 실패로 반환한다', () => {
    expect(parseKafkaJson(message('{oops'), schema)).toEqual({
      ok: false,
      reason: 'message is not valid JSON',
    });
  });

  it('스키마가 맞지 않으면 문제 경로를 담아 실패로 반환한다', () => {
    const result = parseKafkaJson(message('{"id":1}'), schema);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('id');
  });
});
