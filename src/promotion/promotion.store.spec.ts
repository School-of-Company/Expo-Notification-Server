import type { Redis } from 'ioredis';
import { PromotionStore } from './promotion.store';

const recordPrefix = 'promotion:{notifications}:record:';
const prefix = 'expo:';
const record = (n: number) =>
  JSON.stringify({
    event: {
      version: 1,
      eventId: `00000000-0000-4000-8000-00000000000${n}`,
      applicationId: '22222222-2222-4222-8222-222222222222',
      expoId: '33333333-3333-4333-8333-333333333333',
      participantId: 1,
      programType: 'STANDARD',
      programId: 2,
    },
    status: 'PENDING',
    failures: 0,
  });
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const raw = (n: number) => `${prefix}${recordPrefix}${id(n)}`;

const build = (pages: [string, string[]][]) => {
  const scan = jest.fn();
  for (const page of pages) scan.mockResolvedValueOnce(page);
  const redis = {
    options: { keyPrefix: prefix },
    scan,
    get: jest.fn((k: string) => Promise.resolve(record(Number(k.slice(-1))))),
    ttl: jest.fn().mockResolvedValue(-1),
    zrange: jest.fn().mockResolvedValue([]),
    zcard: jest.fn().mockResolvedValue(0),
  };
  return { store: new PromotionStore(redis as unknown as Redis), redis };
};

describe('PromotionStore.snapshot SCAN 중복', () => {
  it('한 페이지에 같은 키가 두 번 와도 한 번만 읽는다', async () => {
    const { store, redis } = build([['0', [raw(1), raw(1)]]]);
    const snapshot = await store.snapshot(10);
    expect(snapshot.records.map((r) => r.id)).toEqual([id(1)]);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(snapshot.truncated).toBe(false);
  });

  it('페이지를 넘어 반복되는 키도 한 번만 읽는다', async () => {
    const { store } = build([
      ['7', [raw(1), raw(2)]],
      ['0', [raw(2), raw(3), raw(1)]],
    ]);
    const snapshot = await store.snapshot(10);
    expect(snapshot.records.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(snapshot.truncated).toBe(false);
  });

  it('limit은 고유 id 수로 센다', async () => {
    const { store } = build([['0', [raw(1), raw(1), raw(2), raw(2)]]]);
    const snapshot = await store.snapshot(2);
    expect(snapshot.records.map((r) => r.id)).toEqual([id(1), id(2)]);
    expect(snapshot.truncated).toBe(false);
  });

  it('고유 id가 limit을 넘을 때만 truncated로 표시한다', async () => {
    const { store } = build([['0', [raw(1), raw(1), raw(2), raw(3)]]]);
    const snapshot = await store.snapshot(2);
    expect(snapshot.records.map((r) => r.id)).toEqual([id(1), id(2)]);
    expect(snapshot.truncated).toBe(true);
  });
});
