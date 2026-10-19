import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

// 다음 자정 스냅샷이 덮어쓰기 전에 사라지지 않을 만큼만 둔다. 끝난 박람회 키는 저절로 정리된다.
const YESTERDAY_TTL_SECONDS = 2 * 24 * 60 * 60;
// ponytail: 인원이 30일 넘게 그대로면 키가 만료되어 한 번 다시 보낸다.
const LAST_SENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const yesterdayKey = (expoId: string) => `alarm:yesterday:${expoId}`;
const lastSentKey = (expoId: string) => `alarm:last-sent:${expoId}`;

@Injectable()
export class ExpoStatStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async findYesterday(expoIds: readonly string[]): Promise<number[]> {
    if (expoIds.length === 0) return [];
    const values = await this.redis.mget(expoIds.map(yesterdayKey));
    return values.map((value) => Number(value ?? 0));
  }

  async saveYesterday(expoId: string, confirmed: number): Promise<void> {
    await this.redis.set(
      yesterdayKey(expoId),
      confirmed,
      'EX',
      YESTERDAY_TTL_SECONDS,
    );
  }

  async findLastSent(expoIds: readonly string[]): Promise<(string | null)[]> {
    if (expoIds.length === 0) return [];
    return this.redis.mget(expoIds.map(lastSentKey));
  }

  async saveLastSent(
    entries: readonly { expoId: string; signature: string }[],
  ): Promise<void> {
    await Promise.all(
      entries.map(({ expoId, signature }) =>
        this.redis.set(
          lastSentKey(expoId),
          signature,
          'EX',
          LAST_SENT_TTL_SECONDS,
        ),
      ),
    );
  }
}
