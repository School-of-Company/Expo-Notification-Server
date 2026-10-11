import { loadConfig } from './load-config';

const env = {
  KAFKA_BROKERS: 'localhost:9092',
  REDIS_HOST: 'localhost',
  SMS_API_KEY: 'synthetic-key',
  SMS_API_SECRET: 'synthetic-secret',
  SMS_FROM_STANDARD_NUMBER: '01000000000',
  SMS_FROM_TRAINEE_NUMBER: '01000000001',
};

describe('Swagger configuration', () => {
  it('선택 값이 없거나 빈 값이면 기본 비활성화', async () => {
    for (const extra of [
      {},
      { SWAGGER_ENABLED: '', SWAGGER_INCLUDE_INTERNAL: '' },
    ]) {
      expect(
        (await loadConfig({ ...env, ...extra }, jest.fn())).swagger,
      ).toEqual({ enabled: false, includeInternal: false });
    }
  });

  it.each(['true', 'false'])('문자열 %s를 boolean으로 파싱', async (value) => {
    expect(
      (
        await loadConfig(
          { ...env, SWAGGER_ENABLED: value, SWAGGER_INCLUDE_INTERNAL: value },
          jest.fn(),
        )
      ).swagger,
    ).toEqual({ enabled: value === 'true', includeInternal: value === 'true' });
  });

  it('설정 서버 boolean이 환경 변수보다 우선', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          swagger: { enabled: false, includeInternal: true },
        }),
    });
    expect(
      (
        await loadConfig(
          {
            ...env,
            SWAGGER_ENABLED: 'true',
            CONFIG_SERVER_URL: 'http://config.test',
          },
          fetchImpl,
        )
      ).swagger,
    ).toEqual({ enabled: false, includeInternal: true });
  });

  it('잘못된 플래그는 부팅 시 거부', async () => {
    await expect(
      loadConfig({ ...env, SWAGGER_ENABLED: 'maybe' }, jest.fn()),
    ).rejects.toThrow('swagger.enabled');
  });
});
