import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

const LEASE_SECONDS = 60 * 5;
const DONE_SECONDS = 60 * 60 * 24;
const key = (eventId: string) => `sms:event:${eventId}`;

@Injectable()
export class SmsEventDedupeStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async claim(eventId: string): Promise<boolean> {
    const result = await this.redis.set(
      key(eventId),
      'processing',
      'EX',
      LEASE_SECONDS,
      'NX',
    );
    return result === 'OK';
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

  async release(eventId: string): Promise<void> {
    await this.redis.del(key(eventId));
  }
}
