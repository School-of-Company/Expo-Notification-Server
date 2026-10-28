import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { ProjectedExpo, projectedExpoSchema } from './expo-changed.schema';

const versionKey = (expoId: string) =>
  `expo-projection:{notifications}:version:${expoId}`;
const recordKey = (expoId: string) =>
  `expo-projection:{notifications}:expo:${expoId}`;
// 삭제 중이 아닌 박람회를 종료일(yyyyMMdd 숫자)로 정렬한 인덱스. 진행 중·예정 목록을 SCAN 없이 읽는다.
const activeIndex = 'expo-projection:{notifications}:active';
// 이벤트를 한 번이라도 반영했다는 표시. 없으면 프로젝션이 비어 있다고 보고 Expo를 동기 조회한다.
const readyKey = 'expo-projection:{notifications}:ready';

// 저장된 version 이하면 반영하지 않는다(재전송·순서 뒤바뀜). tombstone도 version은 남겨 옛 메시지로 되살리지 않는다.
export const APPLY_EXPO_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]))
if current and current >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[3] == '' then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[2])
else
  redis.call('SET', KEYS[2], ARGV[3])
  if ARGV[4] == '' then redis.call('ZREM', KEYS[3], ARGV[2])
  else redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2]) end
end
redis.call('SET', KEYS[4], '1')
return 1`;

const dayScore = (day: string) => day.replaceAll('-', '');

@Injectable()
export class ExpoProjectionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** version이 저장된 값보다 클 때만 박람회 전체를 덮어쓰거나(`expo`) 지운다(`null`). 반영했으면 true. */
  async apply(
    expoId: string,
    version: number,
    expo: ProjectedExpo | null,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      APPLY_EXPO_LUA,
      4,
      versionKey(expoId),
      recordKey(expoId),
      activeIndex,
      readyKey,
      version,
      expoId,
      expo ? JSON.stringify(expo) : '',
      expo && !expo.deleting ? dayScore(expo.finishedDay) : '',
    );
    return result === 1;
  }

  async isReady(): Promise<boolean> {
    return (await this.redis.exists(readyKey)) === 1;
  }

  /** 종료일이 `today`(yyyy-MM-dd) 이후이고 삭제 중이 아닌 박람회. */
  async findActive(today: string): Promise<ProjectedExpo[]> {
    const ids = await this.redis.zrangebyscore(
      activeIndex,
      dayScore(today),
      '+inf',
    );
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map(recordKey));
    return values
      .filter((value): value is string => value !== null)
      .map((value) => projectedExpoSchema.parse(JSON.parse(value)));
  }

  async find(expoId: string): Promise<ProjectedExpo | null> {
    const value = await this.redis.get(recordKey(expoId));
    return value === null ? null : projectedExpoSchema.parse(JSON.parse(value));
  }
}
