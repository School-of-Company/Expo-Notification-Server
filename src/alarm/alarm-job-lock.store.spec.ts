import { Redis } from 'ioredis';
import { AlarmJobLockStore } from './alarm-job-lock.store';

describe('AlarmJobLockStore', () => {
  const redis = { set: jest.fn() };
  const store = new AlarmJobLockStore(redis as unknown as Redis);

  beforeEach(() => redis.set.mockReset());

  it('SET NX EX가 OK면 락 획득, null이면 이미 다른 인스턴스가 보유', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await expect(store.acquire('participant-report', 55)).resolves.toBe(true);
    await expect(store.acquire('participant-report', 55)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith(
      'alarm:lock:participant-report',
      '1',
      'EX',
      55,
      'NX',
    );
  });
});
