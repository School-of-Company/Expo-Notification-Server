import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export interface SmsAuthState {
  code: string;
  verified: boolean;
}

const key = (phoneNumber: string) => `sms:auth:${phoneNumber}`;

@Injectable()
export class SmsAuthStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increaseSendCount(
    phoneNumber: string,
    ttlSeconds: number,
  ): Promise<number> {
    const results = await this.redis
      .multi()
      .hincrby(key(phoneNumber), 'sendCount', 1)
      .expire(key(phoneNumber), ttlSeconds, 'NX')
      .exec();
    const [error, count] = results?.[0] ?? [new Error('empty exec result')];
    if (error) {
      throw error;
    }
    return Number(count);
  }

  async increaseGlobalSendCount(hourBucket: string): Promise<number> {
    const bucketKey = `sms:auth:global:${hourBucket}`;
    const results = await this.redis
      .multi()
      .incr(bucketKey)
      .expire(bucketKey, 2 * 60 * 60, 'NX')
      .exec();
    const [error, count] = results?.[0] ?? [new Error('empty exec result')];
    if (error) {
      throw error;
    }
    return Number(count);
  }

  async saveCode(phoneNumber: string, code: string): Promise<void> {
    await this.redis.hset(key(phoneNumber), { code, verified: '0' });
  }

  async find(phoneNumber: string): Promise<SmsAuthState | null> {
    const fields = await this.redis.hgetall(key(phoneNumber));
    if (!fields.code) {
      return null;
    }
    return { code: fields.code, verified: fields.verified === '1' };
  }

  async increaseVerifyAttemptCount(phoneNumber: string): Promise<number> {
    return this.redis.hincrby(key(phoneNumber), 'verifyAttemptCount', 1);
  }

  async markVerified(phoneNumber: string): Promise<void> {
    await this.redis.hset(key(phoneNumber), 'verified', '1');
  }
}
