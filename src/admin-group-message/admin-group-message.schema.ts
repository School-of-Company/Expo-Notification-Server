import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
const phone = z.string().regex(/^0\d{8,10}$/);
const content = z.string().min(1).max(2000);
const participantId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ledgerKey = z
  .string()
  .max(160)
  .superRefine((value, context) => {
    const [source, expoId, ...parts] = value.split(':');
    const key = parts.join(':');
    const validKey =
      source === 'APPLICATION'
        ? Boolean(
            key &&
            /^[1-9]\d{0,18}$/.test(key) &&
            BigInt(key) <= BigInt('9223372036854775807'),
          )
        : source === 'RESERVATION' && key.trim().length > 0;
    if (!z.uuid().safeParse(expoId).success || !validKey)
      context.addIssue({
        code: 'custom',
        message: 'invalid preregistration ledger key',
      });
  });

export const templateVariablesSchema = z
  .object({
    expoName: z.string().max(200).optional(),
    name: z.string().max(100).optional(),
    programName: z.string().max(200).optional(),
    sessionName: z.string().max(200).optional(),
    location: z.string().max(255).optional(),
    status: z.string().max(200).optional(),
    applicationUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .optional(),
    applicationSummary: z.string().max(500).optional(),
  })
  .strict();

const targetObjectSchema = z
  .object({
    targetId: z.string().min(1).max(160),
    ledgerKey: ledgerKey.optional(),
    applicationId: z.uuid().optional(),
    participantId: participantId.optional(),
    programType: z.enum(['STANDARD', 'TRAINING']).optional(),
    recipientPhone: phone.optional(),
    content: content.optional(),
    templateVariables: templateVariablesSchema.optional(),
    missingReason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((target, context) => {
    const valid =
      target.ledgerKey !== undefined
        ? target.targetId === target.ledgerKey &&
          target.applicationId === undefined &&
          target.programType === undefined &&
          (target.ledgerKey.startsWith('APPLICATION:')
            ? target.participantId !== undefined
            : target.participantId === undefined)
        : target.targetId.length <= 100 &&
          target.applicationId !== undefined &&
          target.programType !== undefined;
    if (!valid)
      context.addIssue({
        code: 'custom',
        message:
          'program and preregistration target identities must not be mixed',
      });
  })
  .refine(
    (target) =>
      target.missingReason
        ? !target.recipientPhone
        : Boolean(target.recipientPhone && target.content),
    {
      message:
        'sendable target requires phone and content; missing target requires missingReason only',
    },
  );

function normalizeProgramTarget(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('targetId' in value) ||
    typeof value.targetId !== 'string' ||
    ('ledgerKey' in value && value.ledgerKey !== undefined)
  )
    return value;
  return { ...value, targetId: value.targetId.trim() };
}

export const groupMessageTargetSchema = z.preprocess(
  normalizeProgramTarget,
  targetObjectSchema,
);

export const createGroupMessagePreviewSchema = z
  .object({
    requesterUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expoId: z.uuid(),
    requestId: z.uuid(),
    applicationCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    channel: z.enum(['SMS', 'KAKAO']),
    templateId: id.optional(),
    // 하위 호환으로만 받는다(생략 가능). 값과 상관없이 KAKAO는 카톡과 문자를 둘 다 보낸다.
    fallbackToSms: z.boolean().optional(),
    targets: z.array(groupMessageTargetSchema).min(1).max(5000),
  })
  .strict()
  .superRefine((value, context) => {
    validateTargetSource(value, context);
    if (value.channel === 'KAKAO' && !value.templateId)
      context.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'templateId is required',
      });
    if (value.channel === 'SMS' && value.templateId)
      context.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'templateId is only valid for KAKAO',
      });
    if (
      new Set(value.targets.map((target) => target.targetId)).size !==
      value.targets.length
    )
      context.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'targetId must be unique',
      });
  });

export const authorizeGroupMessageSchema = z
  .object({
    requesterUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expoId: z.uuid(),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
  })
  .strict();

export const groupMessageBindingSchema = z
  .object({
    requesterUserId: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    expoId: z.uuid(),
  })
  .strict();

export type CreateGroupMessagePreview = z.infer<
  typeof createGroupMessagePreviewSchema
>;
export type GroupMessageTarget = z.infer<typeof groupMessageTargetSchema>;
export type AuthorizeGroupMessage = z.infer<typeof authorizeGroupMessageSchema>;

function validateTargetSource(
  value: { expoId: string; targets: GroupMessageTarget[] },
  context: z.RefinementCtx,
): void {
  const preregistration = value.targets[0]?.ledgerKey !== undefined;
  for (const [index, target] of value.targets.entries()) {
    if (
      (target.ledgerKey !== undefined) !== preregistration ||
      (target.ledgerKey !== undefined &&
        target.ledgerKey.split(':')[1] !== value.expoId)
    )
      context.addIssue({
        code: 'custom',
        path: ['targets', index, 'ledgerKey'],
        message: 'target source and expo must match the preview or job',
      });
  }
}

const targetRecordSchema = z.preprocess(
  normalizeProgramTarget,
  targetObjectSchema.safeExtend({
    status: z.enum([
      'MISSING',
      'PENDING',
      'SENDING',
      'ACCEPTED',
      'DELIVERED',
      'FAILED',
      'UNKNOWN',
    ]),
    attemptId: z.uuid().optional(),
    attemptedAt: z.iso.datetime().optional(),
    groupId: z.string().max(100).optional(),
    messageId: z.string().max(100).optional(),
    deliveryCheckedAt: z.iso.datetime().optional(),
    providerCode: z.string().max(50).optional(),
    failureReason: z.string().max(200).optional(),
  }),
);

export const groupMessagePreviewRecordSchema =
  createGroupMessagePreviewSchema.safeExtend({
    previewId: z.uuid(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  });
export type GroupMessagePreviewRecord = z.infer<
  typeof groupMessagePreviewRecordSchema
>;

export const groupMessageJobSchema = z
  .object({
    jobId: z.string().regex(/^[a-f0-9]{64}$/),
    previewId: z.uuid(),
    requesterUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expoId: z.uuid(),
    applicationCount: z.number().int().positive().optional(),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    channel: z.enum(['SMS', 'KAKAO']),
    templateId: id.optional(),
    // 하위 호환으로 저장만 한다. 발송 동작에는 쓰지 않는다.
    fallbackToSms: z.boolean().optional(),
    status: z.enum([
      'QUEUED',
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'COMPLETED_WITH_FAILURES',
      'ATTENTION',
    ]),
    createdAt: z.iso.datetime(),
    authorizedUntil: z.iso.datetime(),
    reason: z.string().max(200).optional(),
    targets: z.array(targetRecordSchema).min(1).max(5000),
  })
  .superRefine(validateTargetSource);
export type GroupMessageJob = z.infer<typeof groupMessageJobSchema>;

export function parseGroupMessagePreviewRecord(
  raw: string,
): GroupMessagePreviewRecord {
  try {
    const body: unknown = JSON.parse(raw);
    return groupMessagePreviewRecordSchema.parse(body);
  } catch {
    throw new GroupMessageRetryError();
  }
}

// delta는 HGETALL 결과(targetId, JSON, ...). 본문의 같은 대상을 더 새 상태로 덮어쓴다. 없으면 이전 레이아웃 job 그대로다.
export function parseGroupMessageJob(
  raw: string,
  delta: readonly string[] = [],
): GroupMessageJob {
  try {
    const body: unknown = JSON.parse(raw);
    if (delta.length > 0 && typeof body === 'object' && body !== null) {
      const latest = new Map<string, unknown>();
      for (let index = 0; index + 1 < delta.length; index += 2)
        latest.set(delta[index], JSON.parse(delta[index + 1]));
      const record = body as { targets?: Array<{ targetId?: string }> };
      record.targets = record.targets?.map(
        (target) => latest.get(target.targetId ?? '') ?? target,
      );
    }
    return groupMessageJobSchema.parse(body);
  } catch {
    throw new GroupMessageRetryError();
  }
}

export class GroupMessageRetryError extends Error {
  constructor() {
    super('group message retry required');
  }
}
