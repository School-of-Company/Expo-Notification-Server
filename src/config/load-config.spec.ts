import { loadConfig } from './load-config';

const baseEnv = {
  KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
  REDIS_HOST: 'redis',
  SMS_API_KEY: 'env-key',
  SMS_API_SECRET: 'env-secret',
  SMS_FROM_STANDARD_NUMBER: '0623804504',
  SMS_FROM_TRAINEE_NUMBER: '0623804587',
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

describe('loadConfig', () => {
  it('config 서버 없이 env만으로 로드하고 기본값을 채운다', async () => {
    const config = await loadConfig(baseEnv, jest.fn());

    expect(config.kafka.brokers).toEqual(['kafka-1:9092', 'kafka-2:9092']);
    expect(config.kafka.topics.smsRequested).toBe('notification.sms.requested');
    expect(config.redis).toEqual({ host: 'redis', port: 6379 });
    expect(config.sms.authCodeTtlSeconds).toBe(180);
    expect(config.port).toBe(3000);
    expect(config.discord.participantNumberUrl).toBeUndefined();
  });

  it('.env.example처럼 빈 문자열로 둔 선택 값은 미설정으로 취급한다', async () => {
    const config = await loadConfig(
      { ...baseEnv, REDIS_PASSWORD: '', DISCORD_PARTICIPANT_NUMBER_URL: '' },
      jest.fn(),
    );

    expect(config.redis.password).toBeUndefined();
    expect(config.discord.participantNumberUrl).toBeUndefined();
  });

  it('config 서버 값이 env 값보다 우선하고 형제 키는 유지된다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        port: 4000,
        sms: { apiKey: 'vault-key' },
        discord: { participantNumberUrl: 'https://discord.test/hook' },
      }),
    );

    const config = await loadConfig(
      {
        ...baseEnv,
        CONFIG_SERVER_URL: 'http://config:3000/',
        CONFIG_PROFILE: 'dev',
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://config:3000/configs/notification/dev',
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    expect(config.port).toBe(4000);
    expect(config.sms.apiKey).toBe('vault-key');
    expect(config.sms.apiSecret).toBe('env-secret');
    expect(config.discord.participantNumberUrl).toBe(
      'https://discord.test/hook',
    );
  });

  it('CONFIG_SERVICE_NAME으로 조회할 서비스 식별자를 바꾼다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));

    await loadConfig(
      {
        ...baseEnv,
        CONFIG_SERVER_URL: 'http://config',
        CONFIG_SERVICE_NAME: 'sms',
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith('http://config/configs/sms/local', {
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('config 서버가 4xx/5xx를 주면 부팅을 실패시킨다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 404));

    await expect(
      loadConfig({ ...baseEnv, CONFIG_SERVER_URL: 'http://config' }, fetchImpl),
    ).rejects.toThrow('config server responded 404');
  });

  it('config 서버에 연결할 수 없으면 원인 문자열을 노출하지 않고 실패시킨다', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:3000'));

    await expect(
      loadConfig({ ...baseEnv, CONFIG_SERVER_URL: 'http://config' }, fetchImpl),
    ).rejects.toThrow(/^config server unreachable \(notification\/local\)$/);
  });

  it('config 서버 응답이 객체가 아니면 실패시킨다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(['x']));

    await expect(
      loadConfig({ ...baseEnv, CONFIG_SERVER_URL: 'http://config' }, fetchImpl),
    ).rejects.toThrow('non-object body');
  });

  it('필수 값이 빠지면 어느 키가 문제인지 알려주며 실패한다', async () => {
    const env = { ...baseEnv, SMS_API_KEY: undefined };

    await expect(loadConfig(env, jest.fn())).rejects.toThrow(/sms\.apiKey/);
  });

  it('검증 에러 메시지에 비밀 값이 포함되지 않는다', async () => {
    const promise = loadConfig(
      {
        ...baseEnv,
        SMS_API_SECRET: '',
        DISCORD_PARTICIPANT_NUMBER_URL: 'not-a-url',
      },
      jest.fn(),
    );

    await expect(promise).rejects.toThrow(/discord\.participantNumberUrl/);
    await expect(promise).rejects.not.toThrow(/env-key|not-a-url/);
  });
});
