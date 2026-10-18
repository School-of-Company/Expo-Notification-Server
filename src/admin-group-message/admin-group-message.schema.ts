import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
const phone = z.string().regex(/^0\d{8,10}$/);
const content = z.string().min(1).max(2000);

export const templateVariablesSchema = z
  .object({
    expoName: z.string().max(200).optional(),
    name: z.string().max(100).optional(),
    programName: z.string().max(200).optional(),
    sessionName: z.string().max(200).optional(),
    location: z.string().max(255).optional(),
    status: z.string().max(200).optional(),
  })
  .strict();

export const groupMessageTargetSchema = z
  .object({
    targetId: id,
    applicationId: z.uuid(),
    participantId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    programType: z.enum(['STANDARD', 'TRAINING']),
    recipientPhone: phone.optional(),
    content: content.optional(),
    templateVariables: templateVariablesSchema.optional(),
    missingReason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
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

export const createGroupMessagePreviewSchema = z
  .object({
    requesterUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expoId: z.uuid(),
    requestId: z.uuid(),
    applicationCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    channel: z.enum(['SMS', 'KAKAO']),
    templateId: id.optional(),
    // 하위 호환으로만 받는다. 값과 상관없이 KAKAO는 카톡과 문자를 둘 다 보낸다.
    fallbackToSms: z.boolean(),
    targets: z.array(groupMessageTargetSchema).min(1).max(5000),
  })
  .strict()
  .superRefine((value, context) => {
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

const targetRecordSchema = groupMessageTargetSchema.extend({
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
});

export const groupMessagePreviewRecordSchema =
  createGroupMessagePreviewSchema.extend({
    previewId: z.uuid(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  });
export type GroupMessagePreviewRecord = z.infer<
  typeof groupMessagePreviewRecordSchema
>;

export const groupMessageJobSchema = z.object({
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
});
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

export function parseGroupMessageJob(raw: string): GroupMessageJob {
  try {
    const body: unknown = JSON.parse(raw);
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
