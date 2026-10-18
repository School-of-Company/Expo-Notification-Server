import { randomUUID } from 'node:crypto';
import {
  createGroupMessagePreviewSchema,
  groupMessageJobSchema,
} from './admin-group-message.schema';

const preview = (overrides: Record<string, unknown>) => ({
  requesterUserId: 1,
  expoId: randomUUID(),
  requestId: randomUUID(),
  applicationCount: 1,
  targetFingerprint: 'c'.repeat(64),
  channel: 'KAKAO',
  templateId: 'day-before',
  fallbackToSms: true,
  targets: [
    {
      targetId: 'participant',
      applicationId: randomUUID(),
      programType: 'STANDARD',
      recipientPhone: '01012345678',
      content: '안내',
      templateVariables: { expoName: '광주 박람회', status: '대기' },
    },
  ],
  ...overrides,
});

describe('createGroupMessagePreviewSchema', () => {
  it('KAKAO는 fallbackToSms true/false를 모두 받는다', () => {
    for (const fallbackToSms of [true, false])
      expect(
        createGroupMessagePreviewSchema.safeParse(preview({ fallbackToSms }))
          .success,
      ).toBe(true);
  });

  it('SMS도 fallbackToSms true/false를 모두 받는다(하위 호환)', () => {
    for (const fallbackToSms of [true, false])
      expect(
        createGroupMessagePreviewSchema.safeParse(
          preview({ channel: 'SMS', templateId: undefined, fallbackToSms }),
        ).success,
      ).toBe(true);
  });

  it('fallbackToSms가 없거나 boolean이 아니면 거절한다', () => {
    for (const fallbackToSms of [undefined, 'true'])
      expect(
        createGroupMessagePreviewSchema.safeParse(preview({ fallbackToSms }))
          .success,
      ).toBe(false);
  });

  it('expoName·status 변수는 200자까지 받는다', () => {
    const withVariables = (value: string) =>
      createGroupMessagePreviewSchema.safeParse(
        preview({
          targets: [
            {
              ...preview({}).targets[0],
              templateVariables: { expoName: value, status: value },
            },
          ],
        }),
      ).success;

    expect(withVariables('가'.repeat(200))).toBe(true);
    expect(withVariables('가'.repeat(201))).toBe(false);
  });
});

describe('groupMessageJobSchema', () => {
  it('fallbackToSms가 없는 예전 job도 읽는다', () => {
    const job = groupMessageJobSchema.parse({
      jobId: 'a'.repeat(64),
      previewId: randomUUID(),
      requesterUserId: 1,
      expoId: randomUUID(),
      targetFingerprint: 'b'.repeat(64),
      channel: 'KAKAO',
      templateId: 'day-before',
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      authorizedUntil: new Date().toISOString(),
      targets: [{ ...preview({}).targets[0], status: 'PENDING' }],
    });

    expect(job.fallbackToSms).toBeUndefined();
  });
});
