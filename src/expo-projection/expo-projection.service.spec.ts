import type { Redis } from 'ioredis';
import { ExpoChangedEvent } from './expo-changed.schema';
import { ExpoProjectionService } from './expo-projection.service';
import { APPLY_EXPO_LUA, ExpoProjectionStore } from './expo-projection.store';

/** APPLY_EXPO_LUA를 JS로 옮긴 가짜 Redis. 스크립트 자체는 실제 Redis에서 따로 확인했다. */
class ProjectionRedis {
  readonly strings = new Map<string, string>();
  readonly zset = new Map<string, number>();

  eval(script: string, _keys: number, ...args: (string | number)[]) {
    expect(script).toBe(APPLY_EXPO_LUA);
    const [version, record, , ready, nextVersion, expoId, json, score] =
      args.map(String);
    const current = this.strings.get(version);
    if (current !== undefined && Number(current) >= Number(nextVersion))
      return Promise.resolve(0);
    this.strings.set(version, nextVersion);
    if (json === '') {
      this.strings.delete(record);
      this.zset.delete(expoId);
    } else {
      this.strings.set(record, json);
      if (score === '') this.zset.delete(expoId);
      else this.zset.set(expoId, Number(score));
    }
    this.strings.set(ready, '1');
    return Promise.resolve(1);
  }

  exists(key: string) {
    return Promise.resolve(this.strings.has(key) ? 1 : 0);
  }

  get(key: string) {
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  mget(keys: string[]) {
    return Promise.resolve(keys.map((key) => this.strings.get(key) ?? null));
  }

  zrangebyscore(_key: string, min: string) {
    return Promise.resolve(
      [...this.zset].filter(([, s]) => s >= Number(min)).map(([id]) => id),
    );
  }
}

const changed = (
  version: number,
  overrides: Partial<{ title: string; finishedDay: string; deleting: boolean }>,
): ExpoChangedEvent => ({
  schemaVersion: 1,
  eventId: `event-${version}`,
  version,
  expoId: 'expo-1',
  deleted: false,
  expo: {
    title: '광주 박람회',
    startedDay: '2030-01-01',
    finishedDay: '2030-01-02',
    deleting: false,
    ...overrides,
  },
  preregisterSessions: [{ id: 7, title: '1회차' }],
});
const tombstone = (version: number): ExpoChangedEvent => ({
  schemaVersion: 1,
  eventId: `event-${version}`,
  version,
  expoId: 'expo-1',
  deleted: true,
});

describe('ExpoProjectionService', () => {
  let redis: ProjectionRedis;
  let store: ExpoProjectionStore;
  let service: ExpoProjectionService;

  beforeEach(() => {
    redis = new ProjectionRedis();
    store = new ExpoProjectionStore(redis as unknown as Redis);
    service = new ExpoProjectionService(store);
  });

  it('박람회 전체 상태를 덮어쓰고 이 서버가 읽는 필드만 저장한다', async () => {
    expect(await store.isReady()).toBe(false);

    await expect(service.apply(changed(10, {}))).resolves.toBe(true);

    expect(await store.isReady()).toBe(true);
    expect(await store.find('expo-1')).toEqual({
      expoId: 'expo-1',
      title: '광주 박람회',
      startedDay: '2030-01-01',
      finishedDay: '2030-01-02',
      deleting: false,
      sessions: [{ id: 7, title: '1회차' }],
    });
    expect(redis.zset.get('expo-1')).toBe(20300102);
  });

  it('같은 version 재전송과 늦게 온 옛 version은 무시한다', async () => {
    await service.apply(changed(10, { title: '새 제목' }));

    await expect(service.apply(changed(10, { title: '중복' }))).resolves.toBe(
      false,
    );
    await expect(service.apply(changed(9, { title: '옛 제목' }))).resolves.toBe(
      false,
    );

    expect((await store.find('expo-1'))?.title).toBe('새 제목');
  });

  it('tombstone은 프로젝션을 지우고 version을 남겨 옛 메시지로 되살리지 않는다', async () => {
    await service.apply(changed(10, {}));

    await expect(service.apply(tombstone(11))).resolves.toBe(true);
    await expect(service.apply(changed(10, {}))).resolves.toBe(false);

    expect(await store.find('expo-1')).toBeNull();
    expect(redis.zset.has('expo-1')).toBe(false);
    expect(await store.findActive('2030-01-01')).toEqual([]);
    // 지운 뒤에도 이벤트를 받은 적은 있으므로 빈 목록이 정답이다.
    expect(await store.isReady()).toBe(true);
  });

  it('삭제 중인 박람회는 진행 중 목록 인덱스에서 뺀다', async () => {
    await service.apply(changed(10, {}));
    await service.apply(changed(11, { deleting: true }));

    expect(redis.zset.has('expo-1')).toBe(false);
    expect((await store.find('expo-1'))?.deleting).toBe(true);
  });

  it('종료일이 오늘 이전인 박람회는 목록에 없다', async () => {
    await service.apply(changed(10, { finishedDay: '2030-01-02' }));

    expect(await store.findActive('2030-01-02')).toHaveLength(1);
    expect(await store.findActive('2030-01-03')).toEqual([]);
  });
});
