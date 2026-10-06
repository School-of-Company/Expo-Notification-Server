import { z } from 'zod';

const brokers = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((broker) => broker.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

export const appConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  kafka: z.object({
    brokers,
    clientId: z.string().min(1).default('expo-notification-server'),
    smsGroupId: z.string().min(1).default('expo-notification-server.sms'),
    alarmGroupId: z.string().min(1).default('expo-notification-server.alarm'),
    topics: z
      .object({
        smsRequested: z.string().min(1).default('notification.sms.requested'),
        smsDeadLetter: z
          .string()
          .min(1)
          .default('notification.sms.requested.dlq'),
        expoApplicantCount: z
          .string()
          .min(1)
          .default('expo.applicant-count.updated'),
      })
      .prefault({}),
  }),
  redis: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().positive().default(6379),
    password: z.string().min(1).optional(),
  }),
  sms: z.object({
    apiKey: z.string().min(1),
    apiSecret: z.string().min(1),
    fromStandardNumber: z.string().min(1),
    fromTraineeNumber: z.string().min(1),
    authCodeTtlSeconds: z.coerce.number().int().positive().default(180),
    authMaxSendCount: z.coerce.number().int().positive().default(5),
    authMaxSendCountPerHour: z.coerce.number().int().positive().default(300),
    eventMaxAttempts: z.coerce.number().int().positive().default(5),
    authMaxVerifyAttemptCount: z.coerce.number().int().positive().default(5),
  }),
  discord: z
    .object({
      participantNumberUrl: z.url().optional(),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
