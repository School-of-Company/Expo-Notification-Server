import { loadConfig } from './load-config';

const baseEnv = {
  KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
  REDIS_HOST: 'redis',
  SMS_API_KEY: 'env-key',
  SMS_API_SECRET: 'env-secret',
  SMS_FROM_STANDARD_NUMBER: '0623804504',
  SMS_FROM_TRAINEE_NUMBER: '0623804587',
  ATTENTION_SERVICE_URL: 'http://attention:8080',
  ATTENTION_SERVICE_INTERNAL_TOKEN: 'a'.repeat(32),
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
    expect(config.kafka.topics.qrSmsSent).toBe('notification.qr-sms.sent');
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

  it('EUREKA_SERVICE_URL이 없으면 Eureka 등록 설정이 없다 (로컬 개발)', async () => {
    const config = await loadConfig(baseEnv, jest.fn());

    expect(config.eureka).toBeUndefined();
  });

  it('EUREKA_SERVICE_URL과 INSTANCE_* 를 eureka 설정으로 읽는다', async () => {
    const config = await loadConfig(
      {
        ...baseEnv,
        EUREKA_SERVICE_URL: 'http://eureka:8761/eureka',
        INSTANCE_HOSTNAME: 'notification-1',
        INSTANCE_IP_ADDR: '10.0.0.7',
        EUREKA_HEARTBEAT_INTERVAL_SECONDS: '15',
      },
      jest.fn(),
    );

    expect(config.eureka).toEqual({
      serviceUrl: 'http://eureka:8761/eureka',
      heartbeatIntervalSeconds: 15,
      instance: { hostName: 'notification-1', ipAddr: '10.0.0.7' },
    });
  });

  it('내부 호출 토큰이 32자 미만이면 부팅을 실패시킨다 (토큰 값은 노출하지 않는다)', async () => {
    const promise = loadConfig(
      { ...baseEnv, ATTENTION_SERVICE_INTERNAL_TOKEN: 'short-secret' },
      jest.fn(),
    );

    await expect(promise).rejects.toThrow(/attention\.internalToken/);
    await expect(promise).rejects.not.toThrow(/short-secret/);
  });

  it('SMS 관련 선택 설정(행사명, 문의 번호, 설문 URL 템플릿)을 읽는다', async () => {
    const config = await loadConfig(
      {
        ...baseEnv,
        SMS_EXPO_NAME: '광주 박람회',
        SMS_CONTACT_STANDARD_NUMBER: '062-380-4504',
        SMS_SURVEY_URL_TEMPLATE: 'https://survey.example/{expoId}',
      },
      jest.fn(),
    );

    expect(config.sms.expoName).toBe('광주 박람회');
    expect(config.sms.contactStandardNumber).toBe('062-380-4504');
    expect(config.sms.surveyUrlTemplate).toBe(
      'https://survey.example/{expoId}',
    );
    expect(config.sms.contactTraineeNumber).toBeUndefined();
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
