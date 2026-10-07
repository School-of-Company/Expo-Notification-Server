import { z } from 'zod';

const brokers = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((broker) => broker.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const serviceClient = z.object({
  baseUrl: z.url(),
  internalToken: z.string().min(32),
});

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
        participantRegistered: z
          .string()
          .min(1)
          .default('user.participant.registered'),
        entryRecorded: z.string().min(1).default('attention.entry.recorded'),
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
    expoName: z.string().min(1).default('박람회'),
    contactStandardNumber: z.string().min(1).optional(),
    contactTraineeNumber: z.string().min(1).optional(),
    surveyUrlTemplate: z.string().min(1).optional(),
    authMaxVerifyAttemptCount: z.coerce.number().int().positive().default(5),
  }),
  attention: serviceClient,
  user: serviceClient,
  eureka: z
    .object({
      serviceUrl: z.union([z.string().min(1), z.array(z.string().min(1))]),
      heartbeatIntervalSeconds: z.coerce.number().int().positive().optional(),
      leaseDurationSeconds: z.coerce.number().int().positive().optional(),
      requestTimeoutMs: z.coerce.number().int().positive().optional(),
      instance: z
        .object({
          hostName: z.string().min(1).optional(),
          ipAddr: z.string().min(1).optional(),
        })
        .prefault({}),
    })
    .optional(),
  discord: z
    .object({
      participantNumberUrl: z.url().optional(),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
