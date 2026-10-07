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
        participantRegistered: 'user.participant.registered',
        entryRecorded: 'attention.entry.recorded',
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
      expoName: '광주 박람회',
      contactStandardNumber: '062-380-4504',
      contactTraineeNumber: '062-380-4587',
      surveyUrlTemplate: 'https://survey.test/expo/{expoId}',
      authMaxVerifyAttemptCount: 5,
    },
    attention: {
      baseUrl: 'http://attention.test',
      internalToken: 'a'.repeat(32),
    },
    user: { baseUrl: 'http://user.test', internalToken: 'u'.repeat(32) },
    discord: { participantNumberUrl: 'https://discord.test/webhook' },
    ...overrides,
  };
}
