import { AppConfig } from '../../src/config/app-config';

export function createAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    metrics: { enabled: false, port: 0, host: '127.0.0.1' },
    swagger: { enabled: false, includeInternal: false },
    kafka: {
      brokers: ['localhost:9092'],
      clientId: 'expo-notification-server',
      smsGroupId: 'expo-notification-server.sms',
      topics: {
        smsRequested: 'notification.sms.requested',
        smsDeadLetter: 'notification.sms.requested.dlq',
        qrSmsSent: 'notification.qr-sms.sent',
        participantRegistered: 'user.participant.registered',
      },
    },
    redis: { host: 'localhost', port: 6379 },
    sms: {
      apiKey: 'key',
      apiSecret: 'secret',
      fromStandardNumber: '0623804504',
      fromTraineeNumber: '0623804587',
      authCodeTtlSeconds: 180,
      authMaxSendCount: 5,
      authMaxSendCountPerHour: 300,
      authMaxInternalSendCountPerHour: 300,
      authCodeLength: 4,
      eventMaxAttempts: 5,
      expoName: '광주 박람회',
      drawPrizePlace: '입구 운영본부',
      applicationResult: { maxAgeSeconds: 86_400 },
      qrUrlTemplate:
        'https://expo.test/qr?expoId={expoId}&type={participationType}&id={id}&code={code}',
      traineeQrUrlTemplate:
        'https://expo.test/qr?expoId={expoId}&type={participationType}&id={id}&phoneNumber={phoneNumber}',
      authMaxVerifyAttemptCount: 5,
    },
    user: {
      baseUrl: 'http://user.test',
      internalToken: 'a'.repeat(32),
    },
    expo: {
      baseUrl: 'http://expo.test',
      internalToken: 'b'.repeat(32),
    },
    discord: { participantNumberUrl: 'https://discord.test/webhook' },
    ...overrides,
  };
}
