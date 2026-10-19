import { Redis } from 'ioredis';
import { ExpoStatStore } from './expo-stat.store';

describe('ExpoStatStore', () => {
  const redis = { mget: jest.fn(), set: jest.fn() };
  const store = new ExpoStatStore(redis as unknown as Redis);

  beforeEach(() => {
    redis.mget.mockReset();
    redis.set.mockReset();
  });

  it('어제 인원을 박람회 순서대로 읽고, 스냅샷이 없으면 0으로 본다', async () => {
    redis.mget.mockResolvedValue(['4', null]);

    await expect(store.findYesterday(['a', 'b'])).resolves.toEqual([4, 0]);
    expect(redis.mget).toHaveBeenCalledWith([
      'alarm:yesterday:a',
      'alarm:yesterday:b',
    ]);
  });

  it('박람회가 없으면 Redis를 호출하지 않는다', async () => {
    await expect(store.findYesterday([])).resolves.toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('어제 인원은 이틀 TTL로 저장해 끝난 박람회 키가 남지 않는다', async () => {
    await store.saveYesterday('a', 10);

    expect(redis.set).toHaveBeenCalledWith(
      'alarm:yesterday:a',
      10,
      'EX',
      172800,
    );
  });

  it('직전 발송 값을 박람회 순서대로 읽고 30일 TTL로 저장한다', async () => {
    redis.mget.mockResolvedValue(['[1]', null]);

    await expect(store.findLastSent(['a', 'b'])).resolves.toEqual([
      '[1]',
      null,
    ]);
    expect(redis.mget).toHaveBeenCalledWith([
      'alarm:last-sent:a',
      'alarm:last-sent:b',
    ]);

    await store.saveLastSent([{ expoId: 'a', signature: '[2]' }]);
    expect(redis.set).toHaveBeenCalledWith(
      'alarm:last-sent:a',
      '[2]',
      'EX',
      2592000,
    );
  });
});
