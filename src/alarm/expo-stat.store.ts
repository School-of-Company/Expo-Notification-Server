import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

// 다음 자정 스냅샷이 덮어쓰기 전에 사라지지 않을 만큼만 둔다. 끝난 박람회 키는 저절로 정리된다.
const YESTERDAY_TTL_SECONDS = 2 * 24 * 60 * 60;
const yesterdayKey = (expoId: string) => `alarm:yesterday:${expoId}`;

@Injectable()
export class ExpoStatStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async findYesterday(expoIds: readonly string[]): Promise<number[]> {
    if (expoIds.length === 0) return [];
    const values = await this.redis.mget(expoIds.map(yesterdayKey));
    return values.map((value) => Number(value ?? 0));
  }

  async saveYesterday(
    expoId: string,
    applicationPerson: number,
  ): Promise<void> {
    await this.redis.set(
      yesterdayKey(expoId),
      applicationPerson,
      'EX',
      YESTERDAY_TTL_SECONDS,
    );
  }
}
