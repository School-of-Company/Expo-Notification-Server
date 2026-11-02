import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './load-config';

const baseEnv = {
  KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
  REDIS_HOST: 'redis',
  SMS_API_KEY: 'env-key',
  SMS_API_SECRET: 'env-secret',
  SMS_FROM_STANDARD_NUMBER: '0623804504',
  SMS_FROM_TRAINEE_NUMBER: '0623804587',
  SMS_QR_URL_TEMPLATE:
    'https://expo.test/qr?expoId={expoId}&type={participationType}&id={id}&code={code}',
  SMS_TRAINEE_QR_URL_TEMPLATE:
    'https://expo.test/qr?expoId={expoId}&type={participationType}&id={id}&phoneNumber={phoneNumber}',
  USER_SERVICE_URL: 'http://user:8080',
  USER_SERVICE_INTERNAL_TOKEN: 'a'.repeat(32),
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
    expect(config.redis).toEqual({
      host: 'redis',
      port: 6379,
      connectTimeoutMs: 2000,
      commandTimeoutMs: 2000,
      maxRetriesPerRequest: 1,
    });
    expect(config.sms.authCodeTtlSeconds).toBe(300);
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

  it('HTTP 접근 로그는 기본으로 켜지고 HTTP_ACCESS_LOG_ENABLED=false로 끈다', async () => {
    expect((await loadConfig(baseEnv, jest.fn())).httpAccessLog.enabled).toBe(
      true,
    );
    const disabled = await loadConfig(
      { ...baseEnv, HTTP_ACCESS_LOG_ENABLED: 'false' },
      jest.fn(),
    );
    expect(disabled.httpAccessLog.enabled).toBe(false);
  });

  it('박람회 프로젝션은 기본으로 꺼져 있고 KAFKA_EXPO_PROJECTION_* 로 켠다', async () => {
    expect((await loadConfig(baseEnv, jest.fn())).expoProjection).toEqual({
      enabled: false,
      topic: 'expo.expo.changed',
      groupId: 'expo-notification-server.expo-changed',
      deadLetterTopic: 'expo.expo.changed.dlq',
      maxAttempts: 5,
    });
    const enabled = await loadConfig(
      {
        ...baseEnv,
        KAFKA_EXPO_PROJECTION_ENABLED: 'true',
        KAFKA_EXPO_PROJECTION_MAX_ATTEMPTS: '3',
      },
      jest.fn(),
    );
    expect(enabled.expoProjection.enabled).toBe(true);
    expect(enabled.expoProjection.maxAttempts).toBe(3);
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
      { ...baseEnv, USER_SERVICE_INTERNAL_TOKEN: 'short-secret' },
      jest.fn(),
    );

    await expect(promise).rejects.toThrow(/user\.internalToken/);
    await expect(promise).rejects.not.toThrow(/short-secret/);
  });

  it('SMS 설정(행사명, 경품 수령 장소)을 읽는다', async () => {
    const config = await loadConfig(
      {
        ...baseEnv,
        SMS_EXPO_NAME: '광주 박람회',
        SMS_DRAW_PRIZE_PLACE: '본관 1층',
      },
      jest.fn(),
    );

    expect(config.sms.expoName).toBe('광주 박람회');
    expect(config.sms.drawPrizePlace).toBe('본관 1층');
  });

  it('경품 수령 장소 기본값은 입구 운영본부다', async () => {
    const config = await loadConfig(baseEnv, jest.fn());

    expect(config.sms.drawPrizePlace).toBe('입구 운영본부');
  });

  describe('KAKAO_CONFIG_FILE', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'kakao-config-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const write = (content: string) => {
      const path = join(dir, 'kakao.json');
      writeFileSync(path, content);
      return path;
    };

    it('파일의 kakao 설정을 env 설정에 합친다', async () => {
      const path = write(
        JSON.stringify({
          kakao: { pfId: 'pf', auto: { authCode: 'k1' } },
          sms: { expoName: '파일 행사' },
        }),
      );

      const config = await loadConfig(
        { ...baseEnv, KAKAO_CONFIG_FILE: path },
        jest.fn(),
      );

      expect(config.kakao).toEqual({ pfId: 'pf', auto: { authCode: 'k1' } });
      expect(config.sms.expoName).toBe('파일 행사');
      expect(config.sms.apiKey).toBe('env-key');
    });

    it('config 서버 값이 파일 값보다 우선한다', async () => {
      const path = write(JSON.stringify({ kakao: { pfId: 'file-pf' } }));

      const config = await loadConfig(
        {
          ...baseEnv,
          KAKAO_CONFIG_FILE: path,
          CONFIG_SERVER_URL: 'http://config',
        },
        jest
          .fn()
          .mockResolvedValue(jsonResponse({ kakao: { pfId: 'remote' } })),
      );

      expect(config.kakao?.pfId).toBe('remote');
    });

    it.each([
      ['깨진 JSON', '{"kakao":'],
      ['객체가 아닌 JSON', '[]'],
    ])('%s이면 경로만 담은 에러로 부팅을 실패시킨다', async (_, content) => {
      const path = write(content);

      const promise = loadConfig(
        { ...baseEnv, KAKAO_CONFIG_FILE: path },
        jest.fn(),
      );

      await expect(promise).rejects.toThrow(
        `invalid KAKAO_CONFIG_FILE (${path})`,
      );
      await expect(promise).rejects.not.toThrow(/kakao"|JSON|Unexpected/);
    });

    it('파일을 읽지 못하면 부팅을 실패시킨다', async () => {
      const path = join(dir, 'missing.json');

      await expect(
        loadConfig({ ...baseEnv, KAKAO_CONFIG_FILE: path }, jest.fn()),
      ).rejects.toThrow(`invalid KAKAO_CONFIG_FILE (${path})`);
    });

    it('templateId가 있는데 pfId가 없으면 부팅을 실패시킨다', async () => {
      const path = write(
        JSON.stringify({ kakao: { auto: { promotion: 'k3' } } }),
      );

      await expect(
        loadConfig({ ...baseEnv, KAKAO_CONFIG_FILE: path }, jest.fn()),
      ).rejects.toThrow(/kakao\.pfId/);
    });
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
      { signal: expect.any(AbortSignal) as AbortSignal, headers: {} },
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
      headers: {},
    });
  });

  it('CONFIG_SERVER_PASSWORD가 있으면 서비스 식별자로 Basic 인증 헤더를 보낸다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));

    await loadConfig(
      {
        ...baseEnv,
        CONFIG_SERVER_URL: 'http://config',
        CONFIG_SERVER_PASSWORD: 'pw:1',
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://config/configs/notification/local',
      {
        signal: expect.any(AbortSignal) as AbortSignal,
        headers: {
          Authorization: `Basic ${Buffer.from('notification:pw:1').toString('base64')}`,
        },
      },
    );
  });

  it('config 서버가 401을 주면 비밀번호를 노출하지 않고 부팅을 실패시킨다', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 401));
    const loading = loadConfig(
      {
        ...baseEnv,
        CONFIG_SERVER_URL: 'http://config',
        CONFIG_SERVER_PASSWORD: 'secret-pw',
      },
      fetchImpl,
    );

    await expect(loading).rejects.toThrow(
      /^config server responded 401 \(notification\/local\)$/,
    );
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

  it('User 이름 조회 설정은 통째로 없으면 선택 사항이다', async () => {
    const config = await loadConfig(
      { ...baseEnv, USER_SERVICE_URL: '', USER_SERVICE_INTERNAL_TOKEN: '' },
      jest.fn(),
    );
    expect(config.user).toBeUndefined();
  });

  it('QR 템플릿 env를 읽는다', async () => {
    const config = await loadConfig(baseEnv, jest.fn());
    expect(config.sms.qrUrlTemplate).toBe(baseEnv.SMS_QR_URL_TEMPLATE);
    expect(config.sms.traineeQrUrlTemplate).toBe(
      baseEnv.SMS_TRAINEE_QR_URL_TEMPLATE,
    );
  });

  // 비어 있으면 등록 이벤트를 커밋만 하고 QR 문자를 영구히 못 보낸다(#81). 부팅에서 막는다.
  it.each([
    ['일반 누락', { SMS_QR_URL_TEMPLATE: undefined }, /sms\.qrUrlTemplate/],
    ['일반 공백', { SMS_QR_URL_TEMPLATE: '   ' }, /sms\.qrUrlTemplate/],
    [
      '연수 빈 값',
      { SMS_TRAINEE_QR_URL_TEMPLATE: '' },
      /sms\.traineeQrUrlTemplate/,
    ],
  ])(
    'QR 템플릿이 없거나 비면 부팅을 실패시킨다: %s',
    async (_, override, key) => {
      await expect(
        loadConfig({ ...baseEnv, ...override }, jest.fn()),
      ).rejects.toThrow(key);
    },
  );

  it('config 서버의 빈 QR 템플릿도 부팅을 실패시킨다', async () => {
    await expect(
      loadConfig(
        { ...baseEnv, CONFIG_SERVER_URL: 'http://config' },
        jest
          .fn()
          .mockResolvedValue(jsonResponse({ sms: { qrUrlTemplate: '' } })),
      ),
    ).rejects.toThrow(/sms\.qrUrlTemplate/);
  });

  it.each([
    { USER_SERVICE_URL: undefined },
    { USER_SERVICE_INTERNAL_TOKEN: undefined },
    { USER_SERVICE_URL: 'invalid' },
  ])(
    'User 설정 일부만 있거나 URL이 잘못되면 부팅을 실패시킨다: %j',
    async (override) => {
      await expect(
        loadConfig({ ...baseEnv, ...override }, jest.fn()),
      ).rejects.toThrow(/user\./);
    },
  );

  it('템플릿이 문자열이 아니면 값 노출 없이 부팅을 실패시킨다', async () => {
    await expect(
      loadConfig(
        { ...baseEnv, CONFIG_SERVER_URL: 'http://config' },
        jest
          .fn()
          .mockResolvedValue(jsonResponse({ sms: { qrUrlTemplate: 123 } })),
      ),
    ).rejects.toThrow(/sms.qrUrlTemplate/);
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
