import { Redis } from 'ioredis';
import { ExpoStatStore } from './expo-stat.store';

describe('ExpoStatStore', () => {
  const exec = jest.fn();
  const chain = {
    sadd: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
    hsetnx: jest.fn().mockReturnThis(),
    exec,
  };
  const redis = {
    multi: jest.fn(() => chain),
    smembers: jest.fn(),
    hgetall: jest.fn(),
    hset: jest.fn(),
  };
  const store = new ExpoStatStore(redis as unknown as Redis);

  beforeEach(() => {
    redis.smembers.mockReset();
    redis.hgetall.mockReset();
    redis.hset.mockReset();
  });

  beforeEach(() =>
    exec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 1],
    ]),
  );

  it('upsert는 현재 인원을 덮어쓰고 어제 인원은 최초 1회만 0으로 초기화한다', async () => {
    await store.upsert('a', 'A 박람회', 7);

    expect(chain.sadd).toHaveBeenCalledWith('alarm:expos', 'a');
    expect(chain.hset).toHaveBeenCalledWith('alarm:expo:a', {
      title: 'A 박람회',
      applicationPerson: 7,
    });
    expect(chain.hsetnx).toHaveBeenCalledWith(
      'alarm:expo:a',
      'yesterdayApplicationPerson',
      0,
    );
    expect(exec).toHaveBeenCalled();
  });

  it('upsert 트랜잭션의 개별 명령이 실패하면 던진다 (이벤트를 조용히 유실하지 않는다)', async () => {
    exec.mockResolvedValue([
      [null, 1],
      [new Error('READONLY'), null],
      [null, 1],
    ]);

    await expect(store.upsert('a', 'A', 1)).rejects.toThrow('READONLY');
  });

  it('upsert 트랜잭션이 버려지면(null) 던진다', async () => {
    exec.mockResolvedValue(null);

    await expect(store.upsert('a', 'A', 1)).rejects.toThrow('discarded');
  });

  it('findAll은 숫자로 파싱하고 해시가 사라진 박람회는 제외한다', async () => {
    redis.smembers.mockResolvedValue(['a', 'gone']);
    redis.hgetall.mockImplementation((key: string) =>
      Promise.resolve(
        key === 'alarm:expo:a'
          ? {
              title: 'A 박람회',
              applicationPerson: '7',
              yesterdayApplicationPerson: '2',
            }
          : {},
      ),
    );

    await expect(store.findAll()).resolves.toEqual([
      {
        expoId: 'a',
        title: 'A 박람회',
        applicationPerson: 7,
        yesterdayApplicationPerson: 2,
      },
    ]);
  });

  it('saveYesterday는 어제 인원 필드만 갱신한다', async () => {
    await store.saveYesterday('a', 9);

    expect(redis.hset).toHaveBeenCalledWith(
      'alarm:expo:a',
      'yesterdayApplicationPerson',
      9,
    );
  });
});
