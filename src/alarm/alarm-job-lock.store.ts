import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

@Injectable()
export class AlarmJobLockStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async acquire(job: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `alarm:lock:${job}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
