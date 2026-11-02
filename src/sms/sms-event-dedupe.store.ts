import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

const LEASE_SECONDS = 60 * 5;
const PROCESSING_PREFIX = 'processing:';
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
    // 선점 값에 이번 시도의 토큰을 붙인다. SET NX가 적용된 뒤 명령 타임아웃으로 실패해 보여도(#130)
    // 다시 읽어 내 토큰이면 선점한 것으로 본다. 그렇지 않으면 자기 선점을 남의 처리로 보고 5분간 재전달된다.
    const lease = `${PROCESSING_PREFIX}${randomUUID()}`;
    // SET NX와 GET 사이에 키가 만료·해제될 수 있어 한 번 더 선점을 시도한다.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.setLease(eventId, lease)) {
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
            // 'processing'(토큰 이전 값)과 'processing:<token>' 모두 다른 처리 중이다.
            return 'in-progress';
        }
      }
    }
    return 'in-progress';
  }

  private async setLease(eventId: string, lease: string): Promise<boolean> {
    try {
      return (
        (await this.redis.set(
          key(eventId),
          lease,
          'EX',
          LEASE_SECONDS,
          'NX',
        )) === 'OK'
      );
    } catch (error) {
      // 결과를 모른다. 다시 읽어서 내 토큰이 있으면 적용된 것이고, 읽기도 실패하면 처음 오류로 재전달한다.
      const current = await this.redis.get(key(eventId)).catch(() => {
        throw error;
      });
      if (current === lease) {
        return true;
      }
      if (current === null) {
        throw error;
      }
      return false;
    }
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
