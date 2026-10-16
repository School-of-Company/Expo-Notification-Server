import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export interface SmsAuthState {
  code: string;
  verified: boolean;
  window: string;
}

const key = (phoneNumber: string) => `sms:auth:${phoneNumber}`;

// 키가 없거나 TTL이 없거나(이전 버전이 남긴 키) 창 토큰이 없을 때만 TTL과 창 토큰을 함께 심어
// 새 창을 연다. 창 안의 재발송은 TTL을 늘리지 않는다 (최초 발송 기준).
export const OPEN_WINDOW_LUA = `
if redis.call('TTL', KEYS[1]) < 0 or redis.call('HEXISTS', KEYS[1], 'window') == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'window', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {redis.call('HINCRBY', KEYS[1], 'sendCount', 1), redis.call('HGET', KEYS[1], 'window')}`;

// 창이 만료됐거나 새 창으로 바뀌었으면 쓰지 않는다. 그냥 HSET/HINCRBY하면 만료된 키를
// TTL 없이 되살리거나 다른 요청이 연 새 창을 덮어쓴다 (#47).
export const IN_WINDOW_LUA = `
if redis.call('HGET', KEYS[1], 'window') ~= ARGV[1] then return false end
return redis.call(ARGV[2], KEYS[1], unpack(ARGV, 3))`;

@Injectable()
export class SmsAuthStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increaseSendCount(
    phoneNumber: string,
    ttlSeconds: number,
  ): Promise<{ count: number; window: string }> {
    const result = await this.redis.eval(
      OPEN_WINDOW_LUA,
      1,
      key(phoneNumber),
      ttlSeconds,
      randomUUID(),
    );
    if (
      !Array.isArray(result) ||
      typeof result[0] !== 'number' ||
      typeof result[1] !== 'string'
    ) {
      throw new Error('unexpected sms auth window result');
    }
    return { count: result[0], window: result[1] };
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

  /** 창이 그새 만료됐으면 false. */
  async saveCode(
    phoneNumber: string,
    window: string,
    code: string,
  ): Promise<boolean> {
    const result = await this.inWindow(phoneNumber, window, [
      'HSET',
      'code',
      code,
      'verified',
      '0',
    ]);
    return result !== null;
  }

  async find(phoneNumber: string): Promise<SmsAuthState | null> {
    const fields = await this.redis.hgetall(key(phoneNumber));
    if (!fields.code || !fields.window) {
      return null;
    }
    return {
      code: fields.code,
      verified: fields.verified === '1',
      window: fields.window,
    };
  }

  /** 창이 그새 만료됐으면 null. */
  async increaseVerifyAttemptCount(
    phoneNumber: string,
    window: string,
  ): Promise<number | null> {
    const result = await this.inWindow(phoneNumber, window, [
      'HINCRBY',
      'verifyAttemptCount',
      '1',
    ]);
    return typeof result === 'number' ? result : null;
  }

  /** 창이 그새 만료됐으면 false. */
  async markVerified(phoneNumber: string, window: string): Promise<boolean> {
    const result = await this.inWindow(phoneNumber, window, [
      'HSET',
      'verified',
      '1',
    ]);
    return result !== null;
  }

  private inWindow(
    phoneNumber: string,
    window: string,
    command: string[],
  ): Promise<unknown> {
    return this.redis.eval(
      IN_WINDOW_LUA,
      1,
      key(phoneNumber),
      window,
      ...command,
    );
  }
}
