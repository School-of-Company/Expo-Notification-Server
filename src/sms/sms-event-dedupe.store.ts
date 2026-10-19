import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

const LEASE_SECONDS = 60 * 5;
// DLQ 재처리가 사람 손을 거쳐 며칠 뒤에 일어날 수 있어, 완료 마커는 그보다 오래 둔다.
export const SMS_EVENT_DONE_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SMS_EVENT_DONE_MARKER = 'done-v2';
const DONE_SECONDS = SMS_EVENT_DONE_TTL_SECONDS;
const key = (eventId: string) => `sms:event:${eventId}`;
const publishedKey = (eventId: string) => `sms:event-published:${eventId}`;

export type ClaimResult =
  'claimed' | 'in-progress' | 'done' | 'legacy-done' | 'unknown';

@Injectable()
export class SmsEventDedupeStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async claim(eventId: string): Promise<ClaimResult> {
    // SET NX와 GET 사이에 키가 만료·해제될 수 있어 한 번 더 선점을 시도한다.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.redis.set(
        key(eventId),
        'processing',
        'EX',
        LEASE_SECONDS,
        'NX',
      );
      if (result === 'OK') {
        return 'claimed';
      }
      const state = await this.redis.get(key(eventId));
      if (state !== null) {
        switch (state) {
          case 'done':
            return 'legacy-done';
          case SMS_EVENT_DONE_MARKER:
            return 'done';
          case 'sending':
          case 'unknown':
            return 'unknown';
          default:
            return 'in-progress';
        }
      }
    }
    return 'in-progress';
  }

  async isPublished(eventId: string): Promise<boolean> {
    return (await this.redis.exists(publishedKey(eventId))) === 1;
  }

  async markPublished(eventId: string): Promise<void> {
    await this.redis.set(publishedKey(eventId), '1', 'EX', DONE_SECONDS);
  }

  // 공급자 호출 직전 기록. 선점(5분)과 달리 완료 마커만큼 남겨, 재시작·선점 만료 뒤에도 자동 재발송을 막는다.
  // ponytail: 소유자 토큰 없이 덮어쓴다 — 발송 전 단계(이름 조회 등)가 선점 5분 안에 끝난다는 전제. 넘길 수 있으면 토큰 비교(Lua)로 바꾼다.
  async markSending(eventId: string): Promise<void> {
    await this.redis.set(key(eventId), 'sending', 'EX', DONE_SECONDS);
  }

  async markUnknown(eventId: string): Promise<void> {
    await this.redis.set(key(eventId), 'unknown', 'EX', DONE_SECONDS);
  }

  async complete(eventId: string): Promise<void> {
    await this.redis.set(
      key(eventId),
      SMS_EVENT_DONE_MARKER,
      'EX',
      DONE_SECONDS,
    );
  }

  async increaseFailureCount(eventId: string): Promise<number> {
    const failureKey = `sms:event-fail:${eventId}`;
    const results = await this.redis
      .multi()
      .incr(failureKey)
      .expire(failureKey, DONE_SECONDS, 'NX')
      .exec();
    const [error, count] = results?.[0] ?? [new Error('empty exec result')];
    if (error) {
      throw error;
    }
    return Number(count);
  }

  async clearFailureCount(eventId: string): Promise<void> {
    await this.redis.del(`sms:event-fail:${eventId}`);
  }

  async release(eventId: string): Promise<void> {
    await this.redis.del(key(eventId));
  }
}
