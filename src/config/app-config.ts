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

const kakaoVariableMapping = z
  .object({
    expoName: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
    name: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
    programName: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
    sessionName: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
    location: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
    status: z
      .string()
      .regex(/^#\{[^{}]+\}$/)
      .optional(),
  })
  .strict();

const baseAppConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  metrics: z
    .object({
      enabled: z
        .stringbool({ truthy: ['true'], falsy: ['false'] })
        .or(z.boolean())
        .default(true),
      port: z.coerce.number().int().min(0).max(65535).default(9464),
      host: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
    })
    .prefault({}),
  swagger: z
    .object({
      enabled: z
        .stringbool({ truthy: ['true'], falsy: ['false'] })
        .or(z.boolean())
        .default(false),
      includeInternal: z
        .stringbool({ truthy: ['true'], falsy: ['false'] })
        .or(z.boolean())
        .default(false),
    })
    .prefault({}),
  kafka: z.object({
    brokers,
    clientId: z.string().min(1).default('expo-notification-server'),
    smsGroupId: z.string().min(1).default('expo-notification-server.sms'),
    topics: z
      .object({
        smsRequested: z.string().min(1).default('notification.sms.requested'),
        qrSmsSent: z.string().min(1).default('notification.qr-sms.sent'),
        participantRegistered: z
          .string()
          .min(1)
          .default('user.participant.registered'),
        smsDeadLetter: z
          .string()
          .min(1)
          .default('notification.sms.requested.dlq'),
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
    expoName: z.string().min(1).default('AI 미래교육 페스타'),
    // 카카오 K2 템플릿은 문의 줄을 뺄 수 없어 필수다.
    contactStandardNumber: z.string().min(1),
    contactTraineeNumber: z.string().min(1),
    qrUrlTemplate: z.string().trim().optional(),
    traineeQrUrlTemplate: z.string().trim().optional(),
    authMaxVerifyAttemptCount: z.coerce.number().int().positive().default(5),
  }),
  // 자동 발송 알림톡 templateId. 키가 없는 메시지는 문자로만 나간다. 문구는 sms-message.templates.ts 상수에 있다.
  kakao: z
    .object({
      pfId: z.string().min(1).optional(),
      auto: z
        .object({
          authCode: z.string().min(1).optional(),
          qrRegistered: z.string().min(1).optional(),
          promotion: z.string().min(1).optional(),
          drawResult: z.string().min(1).optional(),
        })
        .prefault({}),
    })
    .refine(
      (kakao) => kakao.pfId || Object.values(kakao.auto).every((id) => !id),
      { path: ['pfId'], message: 'pfId is required when a template is set' },
    )
    .optional(),
  user: serviceClient.optional(),
  expo: serviceClient.optional(),
  promotion: z
    .object({
      enabled: z
        .union([
          z.boolean(),
          z.enum(['true', 'false']).transform((value) => value === 'true'),
        ])
        .default(false),
      application: serviceClient,
      internalToken: z.string().min(32),
      topic: z.string().min(1).default('application.program-session.promoted'),
      groupId: z.string().min(1).default('expo-notification-server.promotion'),
    })
    .optional(),
  adminGroupMessaging: z
    .object({
      enabled: z
        .union([
          z.boolean(),
          z.enum(['true', 'false']).transform((value) => value === 'true'),
        ])
        .default(false),
      internalToken: z.string().min(32),
      previewTtlSeconds: z.coerce.number().int().positive().default(1800),
      authorizationTtlSeconds: z.coerce.number().int().positive().default(300),
      retentionSeconds: z.coerce.number().int().positive().default(2592000),
      kakao: z
        .object({
          enabled: z
            .union([
              z.boolean(),
              z.enum(['true', 'false']).transform((value) => value === 'true'),
            ])
            .default(false),
          pfId: z.string().min(1),
          templates: z.array(
            z
              .object({
                id: z.string().min(1).max(100),
                name: z.string().min(1).max(100),
                providerTemplateId: z.string().min(1),
                content: z
                  .string()
                  .min(1)
                  .refine((content) => Array.from(content).length <= 1000, {
                    message: 'approved Kakao content exceeds 1000 characters',
                  }),
                variableMapping: kakaoVariableMapping,
              })
              .superRefine((template, context) => {
                const mapped = Object.values(template.variableMapping);
                const placeholders = [
                  ...template.content.matchAll(/#\{[^{}]+\}/g),
                ].map((match) => match[0]);
                if (
                  new Set(mapped).size !== mapped.length ||
                  placeholders.some(
                    (placeholder) => !mapped.includes(placeholder),
                  ) ||
                  mapped.some(
                    (placeholder) => !placeholders.includes(placeholder),
                  )
                )
                  context.addIssue({
                    code: 'custom',
                    path: ['variableMapping'],
                    message:
                      'mapping must exactly cover unique approved content placeholders',
                  });
              }),
          ),
        })
        .superRefine((kakao, context) => {
          if (kakao.enabled && kakao.templates.length === 0)
            context.addIssue({
              code: 'custom',
              path: ['templates'],
              message:
                'at least one approved template is required when Kakao is enabled',
            });
          const ids = kakao.templates.map((template) => template.id);
          if (new Set(ids).size !== ids.length)
            context.addIssue({
              code: 'custom',
              path: ['templates'],
              message: 'template ids must be unique',
            });
        })
        .optional(),
    })
    .superRefine((settings, context) => {
      if (settings.retentionSeconds < settings.previewTtlSeconds)
        context.addIssue({
          code: 'custom',
          path: ['retentionSeconds'],
          message: 'job retention must not be shorter than preview retention',
        });
    })
    .optional(),
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

export const appConfigSchema = baseAppConfigSchema.refine(
  (config) => !config.metrics.enabled || config.metrics.port !== config.port,
  {
    path: ['metrics', 'port'],
    message: 'metrics port must differ from service port',
  },
);

export type AppConfig = z.infer<typeof appConfigSchema>;
