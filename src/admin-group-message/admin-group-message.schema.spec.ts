import { randomUUID } from 'node:crypto';
import {
  createGroupMessagePreviewSchema,
  groupMessageJobSchema,
  parseGroupMessageJob,
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

  it('fallbackToSms는 생략할 수 있고 boolean이 아니면 거절한다', () => {
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview({ fallbackToSms: undefined }),
      ).success,
    ).toBe(true);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview({ fallbackToSms: 'true' }),
      ).success,
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

  it('applicationUrl은 500자 이하 https만, applicationSummary는 500자까지 받는다', () => {
    const withVariables = (templateVariables: Record<string, string>) =>
      createGroupMessagePreviewSchema.safeParse(
        preview({
          targets: [{ ...preview({}).targets[0], templateVariables }],
        }),
      ).success;
    const url = 'https://expo.example/qr/';

    expect(
      withVariables({
        applicationUrl: url + 'a'.repeat(500 - url.length),
        applicationSummary: '가\n'.repeat(250),
      }),
    ).toBe(true);
    expect(
      withVariables({ applicationUrl: url + 'a'.repeat(501 - url.length) }),
    ).toBe(false);
    expect(withVariables({ applicationUrl: 'http://expo.example/qr/1' })).toBe(
      false,
    );
    expect(withVariables({ applicationSummary: '가'.repeat(501) })).toBe(false);
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

describe('parseGroupMessageJob 증분 덮어쓰기', () => {
  const target = (targetId: string) => ({
    targetId,
    applicationId: randomUUID(),
    programType: 'STANDARD',
    recipientPhone: '01012345678',
    content: '안내',
    status: 'PENDING',
  });
  const raw = JSON.stringify({
    jobId: 'a'.repeat(64),
    previewId: randomUUID(),
    requesterUserId: 1,
    expoId: randomUUID(),
    targetFingerprint: 'b'.repeat(64),
    channel: 'SMS',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    authorizedUntil: new Date().toISOString(),
    targets: [target('t1'), target('t2')],
  });

  it('증분이 없으면 이전 레이아웃 job을 그대로 읽는다', () => {
    const job = parseGroupMessageJob(raw);
    expect(job.targets.map((item) => item.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
  });

  it('증분의 대상 상태가 본문보다 우선하고 순서는 유지된다', () => {
    const sending = {
      ...target('t1'),
      status: 'SENDING',
      attemptId: randomUUID(),
      attemptedAt: new Date().toISOString(),
    };
    const job = parseGroupMessageJob(raw, ['t1', JSON.stringify(sending)]);
    expect(job.targets.map((item) => [item.targetId, item.status])).toEqual([
      ['t1', 'SENDING'],
      ['t2', 'PENDING'],
    ]);
  });
});
