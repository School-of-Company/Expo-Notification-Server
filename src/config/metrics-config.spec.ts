import { loadConfig } from './load-config';

const env = {
  KAFKA_BROKERS: 'localhost:9092',
  REDIS_HOST: 'localhost',
  SMS_API_KEY: 'synthetic-key',
  SMS_API_SECRET: 'synthetic-secret',
  SMS_FROM_STANDARD_NUMBER: '01000000000',
  SMS_FROM_TRAINEE_NUMBER: '01000000001',
};

describe('Metrics configuration', () => {
  it('기본 활성화, 규약 포트와 Gateway의 loopback 기본값을 사용한다', async () => {
    const config = await loadConfig(env, jest.fn());
    expect(config.metrics).toEqual({
      enabled: true,
      port: 9464,
      host: '127.0.0.1',
    });
  });

  it('환경값의 disabled, 포트, 내부 bind IP를 읽는다', async () => {
    const config = await loadConfig(
      {
        ...env,
        METRICS_ENABLED: 'false',
        METRICS_PORT: '9500',
        METRICS_HOST: '10.0.0.2',
      },
      jest.fn(),
    );
    expect(config.metrics).toEqual({
      enabled: false,
      port: 9500,
      host: '10.0.0.2',
    });
  });

  it('Config Server 설정이 env보다 우선하고 host는 유지한다', async () => {
    const config = await loadConfig(
      {
        ...env,
        CONFIG_SERVER_URL: 'http://config.test',
        METRICS_ENABLED: 'false',
        METRICS_PORT: '9500',
        METRICS_HOST: '10.0.0.2',
      },
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ metrics: { enabled: true, port: 9464 } }),
      }),
    );
    expect(config.metrics).toEqual({
      enabled: true,
      port: 9464,
      host: '10.0.0.2',
    });
  });

  it.each([
    { METRICS_ENABLED: 'maybe' },
    { METRICS_PORT: '-1' },
    { METRICS_PORT: '65536' },
    { METRICS_PORT: '1.5' },
    { METRICS_PORT: '3000' },
    { METRICS_HOST: 'not-an-ip' },
  ])('잘못된 설정을 거부한다: %j', async (extra) => {
    await expect(loadConfig({ ...env, ...extra }, jest.fn())).rejects.toThrow(
      'metrics.',
    );
  });

  it('disabled에서는 서비스와 같은 포트를 설정해도 listener를 사용하지 않는다', async () => {
    const config = await loadConfig(
      { ...env, METRICS_ENABLED: 'false', METRICS_PORT: '3000' },
      jest.fn(),
    );
    expect(config.metrics.enabled).toBe(false);
  });
});
