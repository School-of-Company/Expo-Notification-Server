import { AppConfig } from '../../src/config/app-config';

export function createAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    kafka: {
      brokers: ['localhost:9092'],
      clientId: 'expo-notification-server',
      smsGroupId: 'expo-notification-server.sms',
      alarmGroupId: 'expo-notification-server.alarm',
      topics: {
        smsRequested: 'notification.sms.requested',
        smsDeadLetter: 'notification.sms.requested.dlq',
        expoApplicantCount: 'expo.applicant-count.updated',
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
      eventMaxAttempts: 5,
      authMaxVerifyAttemptCount: 5,
    },
    discord: { participantNumberUrl: 'https://discord.test/webhook' },
    ...overrides,
  };
}
