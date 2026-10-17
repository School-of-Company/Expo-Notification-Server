import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import type { GroupMessageJob } from './admin-group-message.schema';
import { GroupMessageSolapiProvider } from './group-message-solapi.provider';

describe('admin group message Solapi transport', () => {
  const target = {
    targetId: 'participant-1',
    applicationId: randomUUID(),
    participantId: 1,
    programType: 'STANDARD' as const,
    recipientPhone: '01012345678',
    content: '김학생님의 미래 수업 안내',
    templateVariables: { name: '김학생', programName: '미래 수업' },
    status: 'SENDING' as const,
    attemptId: randomUUID(),
  };
  const job: GroupMessageJob = {
    jobId: 'a'.repeat(64),
    previewId: randomUUID(),
    requesterUserId: 1,
    expoId: randomUUID(),
    targetFingerprint: 'b'.repeat(64),
    channel: 'SMS',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    authorizedUntil: new Date(Date.now() + 60_000).toISOString(),
    targets: [target],
  };

  afterEach(() => jest.restoreAllMocks());

  it('makes one HTTP attempt and leaves timeout acceptance unknown', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new DOMException('synthetic timeout', 'TimeoutError'));
    const provider = new GroupMessageSolapiProvider(createAppConfig());
    await expect(provider.send(job, target)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['예전 job(필드 없음)', undefined, true],
    ['대체 발송 끔', false, true],
    ['대체 발송 켬', true, false],
  ])(
    'maps semantic variables only through configured approved Kakao names: %s',
    async (_, fallbackToSms, disableSms) => {
      const config = createAppConfig({
        adminGroupMessaging: {
          enabled: true,
          internalToken: 'g'.repeat(32),
          previewTtlSeconds: 1800,
          authorizationTtlSeconds: 300,
          retentionSeconds: 2592000,
          kakao: {
            enabled: true,
            pfId: 'pf-id',
            templates: [
              {
                id: 'approved-1',
                name: '승인 안내',
                providerTemplateId: 'provider-template',
                content: '[#{행사명}] #{이름}님의 #{프로그램} #{상태} 안내',
                variableMapping: {
                  expoName: '#{행사명}',
                  name: '#{이름}',
                  programName: '#{프로그램}',
                  status: '#{상태}',
                },
              },
            ],
          },
        },
      });
      const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            groupInfo: {
              groupId: 'group-1',
              count: { registeredSuccess: 1, registeredFailed: 0 },
            },
            failedMessageList: [],
            messageList: [{ messageId: 'message-1', statusCode: '2000' }],
          }),
        ),
      );
      const provider = new GroupMessageSolapiProvider(config);
      await expect(
        provider.send(
          { ...job, channel: 'KAKAO', templateId: 'approved-1', fallbackToSms },
          {
            ...target,
            templateVariables: {
              ...target.templateVariables,
              expoName: '광주 박람회',
              status: '대기',
            },
          },
        ),
      ).resolves.toEqual({
        kind: 'accepted',
        groupId: 'group-1',
        messageId: 'message-1',
      });
      const init = fetch.mock.calls[0]?.[1];
      if (typeof init?.body !== 'string')
        throw new Error('missing JSON request');
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({
        messages: [
          {
            kakaoOptions: {
              pfId: 'pf-id',
              templateId: 'provider-template',
              variables: {
                '#{행사명}': '광주 박람회',
                '#{이름}': '김학생',
                '#{프로그램}': '미래 수업',
                '#{상태}': '대기',
              },
              disableSms,
            },
          },
        ],
        allowDuplicates: false,
      });
    },
  );

  it('does not trust empty receipt IDs or contradictory provider counts', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          groupInfo: {
            groupId: '',
            count: { registeredSuccess: 1, registeredFailed: 1 },
          },
          failedMessageList: [],
          messageList: [{ messageId: '', statusCode: '2000' }],
        }),
      ),
    );
    const provider = new GroupMessageSolapiProvider(createAppConfig());
    await expect(provider.send(job, target)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
