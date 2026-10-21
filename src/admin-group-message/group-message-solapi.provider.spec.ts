import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import type { GroupMessageJob } from './admin-group-message.schema';
import { GroupMessageSolapiProvider } from './group-message-solapi.provider';
import { groupKakaoMessage } from './group-message-sender.interface';

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
    ['예전 job(필드 없음)', undefined],
    ['fallbackToSms false', false],
    ['fallbackToSms true', true],
  ])(
    'KAKAO job은 문자만 보내고, 카톡 건은 승인 변수명으로 매핑해 대체 문자를 끈다: %s',
    async (_, fallbackToSms) => {
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
                fixedVariables: {},
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
      const kakaoJob: GroupMessageJob = {
        ...job,
        channel: 'KAKAO',
        templateId: 'approved-1',
        fallbackToSms,
      };
      const kakaoTarget = {
        ...target,
        templateVariables: {
          ...target.templateVariables,
          expoName: '광주 박람회',
          status: '대기',
        },
      };
      await expect(provider.send(kakaoJob, kakaoTarget)).resolves.toEqual({
        kind: 'accepted',
        groupId: 'group-1',
        messageId: 'message-1',
      });
      const init = fetch.mock.calls[0]?.[1];
      if (typeof init?.body !== 'string')
        throw new Error('missing JSON request');
      const body = JSON.parse(init.body) as {
        messages: Record<string, unknown>[];
      };
      expect(body).toMatchObject({
        messages: [{ to: '01012345678', text: target.content }],
        allowDuplicates: false,
      });
      expect(body.messages[0]).not.toHaveProperty('kakaoOptions');
      expect(groupKakaoMessage(config, kakaoJob, kakaoTarget)).toEqual({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: target.content,
        kakaoOptions: {
          pfId: 'pf-id',
          templateId: 'provider-template',
          variables: {
            '#{행사명}': '광주 박람회',
            '#{이름}': '김학생',
            '#{프로그램}': '미래 수업',
            '#{상태}': '대기',
          },
          disableSms: true,
        },
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
