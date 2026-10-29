import { buildRedisOptions } from './redis-options';

describe('buildRedisOptions', () => {
  const redis = {
    host: 'redis',
    port: 6379,
    password: 'pw',
    connectTimeoutMs: 1500,
    commandTimeoutMs: 2500,
    maxRetriesPerRequest: 2,
  };

  it('설정값을 ioredis 타임아웃·재시도 옵션으로 옮긴다', () => {
    expect(buildRedisOptions(redis)).toMatchObject({
      host: 'redis',
      port: 6379,
      password: 'pw',
      connectTimeout: 1500,
      commandTimeout: 2500,
      maxRetriesPerRequest: 2,
    });
  });

  it('재연결 간격은 200ms씩 늘다가 2초에서 멈춘다', () => {
    const { retryStrategy } = buildRedisOptions(redis);

    expect(retryStrategy?.(1)).toBe(200);
    expect(retryStrategy?.(5)).toBe(1000);
    expect(retryStrategy?.(50)).toBe(2000);
  });
});
