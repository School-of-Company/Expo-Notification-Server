import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

const LEASE_SECONDS = 60 * 5;
// DLQ 재처리가 사람 손을 거쳐 며칠 뒤에 일어날 수 있어, 완료 마커는 그보다 오래 둔다.
const DONE_SECONDS = 60 * 60 * 24 * 7;
const key = (eventId: string) => `sms:event:${eventId}`;
const publishedKey = (eventId: string) => `sms:event-published:${eventId}`;

export type ClaimResult = 'claimed' | 'in-progress' | 'done';

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
        return state === 'done' ? 'done' : 'in-progress';
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

  async complete(eventId: string): Promise<void> {
    await this.redis.set(key(eventId), 'done', 'EX', DONE_SECONDS);
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
