import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export interface ExpoStat {
  expoId: string;
  title: string;
  applicationPerson: number;
  yesterdayApplicationPerson: number;
}

const EXPO_IDS_KEY = 'alarm:expos';
const statKey = (expoId: string) => `alarm:expo:${expoId}`;

@Injectable()
export class ExpoStatStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async upsert(
    expoId: string,
    title: string,
    applicationPerson: number,
  ): Promise<void> {
    const results = await this.redis
      .multi()
      .sadd(EXPO_IDS_KEY, expoId)
      .hset(statKey(expoId), { title, applicationPerson })
      .hsetnx(statKey(expoId), 'yesterdayApplicationPerson', 0)
      .exec();
    const failed = results?.find(([error]) => error);
    if (!results || failed) {
      throw failed?.[0] ?? new Error('redis transaction was discarded');
    }
  }

  async findAll(): Promise<ExpoStat[]> {
    const expoIds = await this.redis.smembers(EXPO_IDS_KEY);
    const stats = await Promise.all(
      expoIds.map(async (expoId) => {
        const fields = await this.redis.hgetall(statKey(expoId));
        if (!fields.title) {
          return null;
        }
        return {
          expoId,
          title: fields.title,
          applicationPerson: Number(fields.applicationPerson ?? 0),
          yesterdayApplicationPerson: Number(
            fields.yesterdayApplicationPerson ?? 0,
          ),
        };
      }),
    );
    return stats.filter((stat): stat is ExpoStat => stat !== null);
  }

  async saveYesterday(
    expoId: string,
    applicationPerson: number,
  ): Promise<void> {
    await this.redis.hset(
      statKey(expoId),
      'yesterdayApplicationPerson',
      applicationPerson,
    );
  }
}
