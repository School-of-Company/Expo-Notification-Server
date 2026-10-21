import { readFileSync } from 'node:fs';
import { deepMerge } from './deep-merge';
import { AppConfig, appConfigSchema } from './app-config';

type Env = Record<string, string | undefined>;
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const DEFAULT_SERVICE_NAME = 'notification';
const DEFAULT_PROFILE = 'local';

function pickDefined<T extends Record<string, unknown>>(
  entries: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  ) as Partial<T>;
}

function eurekaFromEnv(env: Env): Record<string, unknown> {
  if (!env.EUREKA_SERVICE_URL) {
    return {};
  }
  return {
    eureka: {
      ...pickDefined({
        serviceUrl: env.EUREKA_SERVICE_URL,
        heartbeatIntervalSeconds: env.EUREKA_HEARTBEAT_INTERVAL_SECONDS,
        leaseDurationSeconds: env.EUREKA_LEASE_DURATION_SECONDS,
        requestTimeoutMs: env.EUREKA_REQUEST_TIMEOUT_MS,
      }),
      instance: pickDefined({
        hostName: env.INSTANCE_HOSTNAME,
        ipAddr: env.INSTANCE_IP_ADDR,
      }),
    },
  };
}

function configFromEnv(env: Env): Record<string, unknown> {
  return {
    ...pickDefined({ port: env.PORT }),
    metrics: pickDefined({
      enabled: env.METRICS_ENABLED,
      port: env.METRICS_PORT,
      host: env.METRICS_HOST,
    }),
    swagger: pickDefined({
      enabled: env.SWAGGER_ENABLED,
      includeInternal: env.SWAGGER_INCLUDE_INTERNAL,
    }),
    kafka: pickDefined({
      brokers: env.KAFKA_BROKERS,
      clientId: env.KAFKA_CLIENT_ID,
      smsGroupId: env.KAFKA_SMS_GROUP_ID,
      topics: pickDefined({
        smsRequested: env.KAFKA_SMS_REQUESTED_TOPIC,
        smsDeadLetter: env.KAFKA_SMS_DEAD_LETTER_TOPIC,
        qrSmsSent: env.KAFKA_QR_SMS_SENT_TOPIC,
        participantRegistered: env.KAFKA_PARTICIPANT_REGISTERED_TOPIC,
      }),
    }),
    redis: pickDefined({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
    }),
    sms: pickDefined({
      apiKey: env.SMS_API_KEY,
      apiSecret: env.SMS_API_SECRET,
      fromStandardNumber: env.SMS_FROM_STANDARD_NUMBER,
      fromTraineeNumber: env.SMS_FROM_TRAINEE_NUMBER,
      authCodeTtlSeconds: env.SMS_AUTH_CODE_TTL_SECONDS,
      authMaxSendCount: env.SMS_AUTH_MAX_SEND_COUNT,
      authMaxSendCountPerHour: env.SMS_AUTH_MAX_SEND_COUNT_PER_HOUR,
      authMaxInternalSendCountPerHour:
        env.SMS_AUTH_MAX_INTERNAL_SEND_COUNT_PER_HOUR,
      authInternalToken: env.SMS_AUTH_INTERNAL_TOKEN,
      authCodeLength: env.SMS_AUTH_CODE_LENGTH,
      eventMaxAttempts: env.SMS_EVENT_MAX_ATTEMPTS,
      expoName: env.SMS_EXPO_NAME,
      drawPrizePlace: env.SMS_DRAW_PRIZE_PLACE,
      qrUrlTemplate: env.SMS_QR_URL_TEMPLATE,
      traineeQrUrlTemplate: env.SMS_TRAINEE_QR_URL_TEMPLATE,
      authMaxVerifyAttemptCount: env.SMS_AUTH_MAX_VERIFY_ATTEMPT_COUNT,
      apiBaseUrl: env.SMS_API_BASE_URL,
    }),
    ...((env.USER_SERVICE_URL || env.USER_SERVICE_INTERNAL_TOKEN) && {
      user: pickDefined({
        baseUrl: env.USER_SERVICE_URL,
        internalToken: env.USER_SERVICE_INTERNAL_TOKEN,
      }),
    }),
    ...((env.EXPO_SERVICE_URL || env.EXPO_SERVICE_INTERNAL_TOKEN) && {
      expo: pickDefined({
        baseUrl: env.EXPO_SERVICE_URL,
        internalToken: env.EXPO_SERVICE_INTERNAL_TOKEN,
      }),
    }),
    ...eurekaFromEnv(env),
    ...((env.PROMOTION_APPLICATION_URL || env.PROMOTION_ENABLED) && {
      promotion: {
        ...pickDefined({
          enabled: env.PROMOTION_ENABLED,
          internalToken: env.PROMOTION_INTERNAL_TOKEN,
          topic: env.KAFKA_PROMOTION_TOPIC,
          groupId: env.KAFKA_PROMOTION_GROUP_ID,
          recoveryHold: env.PROMOTION_RECOVERY_HOLD,
        }),
        application: pickDefined({
          baseUrl: env.PROMOTION_APPLICATION_URL,
          internalToken: env.PROMOTION_APPLICATION_INTERNAL_TOKEN,
        }),
      },
    }),
    ...((env.PROMOTION_OFFER_APPLICATION_URL ||
      env.PROMOTION_OFFER_ENABLED) && {
      promotionOffer: {
        ...pickDefined({
          enabled: env.PROMOTION_OFFER_ENABLED,
          internalToken: env.PROMOTION_OFFER_INTERNAL_TOKEN,
          topic: env.KAFKA_PROMOTION_OFFER_TOPIC,
          groupId: env.KAFKA_PROMOTION_OFFER_GROUP_ID,
        }),
        application: pickDefined({
          baseUrl: env.PROMOTION_OFFER_APPLICATION_URL,
          internalToken: env.PROMOTION_OFFER_APPLICATION_INTERNAL_TOKEN,
        }),
      },
    }),
    ...((env.ADMIN_GROUP_MESSAGING_ENABLED ||
      env.ADMIN_GROUP_MESSAGING_INTERNAL_TOKEN) && {
      adminGroupMessaging: pickDefined({
        enabled: env.ADMIN_GROUP_MESSAGING_ENABLED,
        internalToken: env.ADMIN_GROUP_MESSAGING_INTERNAL_TOKEN,
        previewTtlSeconds: env.ADMIN_GROUP_MESSAGING_PREVIEW_TTL_SECONDS,
        authorizationTtlSeconds:
          env.ADMIN_GROUP_MESSAGING_AUTHORIZATION_TTL_SECONDS,
        retentionSeconds: env.ADMIN_GROUP_MESSAGING_RETENTION_SECONDS,
      }),
    }),
    discord: pickDefined({
      participantNumberUrl: env.DISCORD_PARTICIPANT_NUMBER_URL,
    }),
  };
}

// 운영 서버는 .env만 읽어서 알림톡 설정(templateId 목록)은 JSON 파일로 받는다.
function kakaoFromFile(env: Env): Record<string, unknown> {
  const path = env.KAKAO_CONFIG_FILE;
  if (!path) {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`invalid KAKAO_CONFIG_FILE (${path})`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`invalid KAKAO_CONFIG_FILE (${path})`);
  }
  return body as Record<string, unknown>;
}

// config-server Basic 인증(Expo-Config-Server#54). 사용자 이름은 조회하는 서비스 식별자다.
// 비밀번호가 없으면 헤더 없이 호출해 인증을 켜기 전의 config-server 와도 동작한다.
function basicAuthHeader(
  service: string,
  password: string | undefined,
): Record<string, string> {
  if (!password) {
    return {};
  }
  const credentials = Buffer.from(`${service}:${password}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

async function fetchRemoteConfig(
  env: Env,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const baseUrl = env.CONFIG_SERVER_URL;
  if (!baseUrl) {
    return {};
  }
  const service = env.CONFIG_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;
  const profile = env.CONFIG_PROFILE ?? DEFAULT_PROFILE;
  const url = `${baseUrl.replace(/\/+$/, '')}/configs/${encodeURIComponent(service)}/${encodeURIComponent(profile)}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
      headers: basicAuthHeader(service, env.CONFIG_SERVER_PASSWORD),
    });
  } catch {
    throw new Error(`config server unreachable (${service}/${profile})`);
  }
  if (!response.ok) {
    throw new Error(
      `config server responded ${response.status} (${service}/${profile})`,
    );
  }
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(
      `config server returned a non-object body (${service}/${profile})`,
    );
  }
  return body as Record<string, unknown>;
}

export async function loadConfig(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<AppConfig> {
  const remote = await fetchRemoteConfig(env, fetchImpl);
  const result = appConfigSchema.safeParse(
    deepMerge(deepMerge(configFromEnv(env), kakaoFromFile(env)), remote),
  );
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid configuration — ${issues}`);
  }
  return result.data;
}
