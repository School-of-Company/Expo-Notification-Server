import { deepMerge } from './deep-merge';
import { AppConfig, appConfigSchema } from './app-config';

type Env = Record<string, string | undefined>;
type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
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
    kafka: pickDefined({
      brokers: env.KAFKA_BROKERS,
      clientId: env.KAFKA_CLIENT_ID,
      smsGroupId: env.KAFKA_SMS_GROUP_ID,
      alarmGroupId: env.KAFKA_ALARM_GROUP_ID,
      topics: pickDefined({
        smsRequested: env.KAFKA_SMS_REQUESTED_TOPIC,
        smsDeadLetter: env.KAFKA_SMS_DEAD_LETTER_TOPIC,
        participantRegistered: env.KAFKA_PARTICIPANT_REGISTERED_TOPIC,
        entryRecorded: env.KAFKA_ENTRY_RECORDED_TOPIC,
        expoApplicantCount: env.KAFKA_EXPO_APPLICANT_COUNT_TOPIC,
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
      eventMaxAttempts: env.SMS_EVENT_MAX_ATTEMPTS,
      expoName: env.SMS_EXPO_NAME,
      contactStandardNumber: env.SMS_CONTACT_STANDARD_NUMBER,
      contactTraineeNumber: env.SMS_CONTACT_TRAINEE_NUMBER,
      surveyUrlTemplate: env.SMS_SURVEY_URL_TEMPLATE,
      authMaxVerifyAttemptCount: env.SMS_AUTH_MAX_VERIFY_ATTEMPT_COUNT,
    }),
    attention: pickDefined({
      baseUrl: env.ATTENTION_SERVICE_URL,
      internalToken: env.ATTENTION_SERVICE_INTERNAL_TOKEN,
    }),
    user: pickDefined({
      baseUrl: env.USER_SERVICE_URL,
      internalToken: env.USER_SERVICE_INTERNAL_TOKEN,
    }),
    ...eurekaFromEnv(env),
    discord: pickDefined({
      participantNumberUrl: env.DISCORD_PARTICIPANT_NUMBER_URL,
    }),
  };
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
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
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
    deepMerge(configFromEnv(env), remote),
  );
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid configuration — ${issues}`);
  }
  return result.data;
}
