import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import {
  mockKakaoFetch,
  sentKakaoMessages,
} from '../../test/fixtures/kakao-fetch.fixture';
import { KakaoSenderProvider } from '../sms/kakao-sender.provider';
import type { GroupMessageJob } from './admin-group-message.schema';
import type { CreateGroupMessagePreview } from './admin-group-message.schema';
import { AdminGroupMessageService } from './admin-group-message.service';
import { AdminGroupMessageStore } from './admin-group-message.store';
import type { GroupMessageSender } from './group-message-sender.interface';

describe('AdminGroupMessageService processing safety', () => {
  const target = (status: GroupMessageJob['targets'][number]['status']) => ({
    targetId: `target-${status}`,
    applicationId: randomUUID(),
    participantId: 1,
    programType: 'STANDARD' as const,
    recipientPhone: '01012345678',
    content: '개별 안내',
    status,
    ...(status === 'SENDING'
      ? { attemptId: randomUUID(), attemptedAt: new Date().toISOString() }
      : {}),
    ...(status === 'ACCEPTED'
      ? {
          attemptId: randomUUID(),
          attemptedAt: new Date().toISOString(),
          groupId: 'group',
          messageId: 'message',
        }
      : {}),
  });
  const job = (targets: GroupMessageJob['targets']): GroupMessageJob => ({
    jobId: 'a'.repeat(64),
    previewId: randomUUID(),
    requesterUserId: 1,
    expoId: randomUUID(),
    targetFingerprint: 'b'.repeat(64),
    channel: 'SMS',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    authorizedUntil: new Date(Date.now() + 60_000).toISOString(),
    targets,
  });

  function setup(record: GroupMessageJob, enabled = true) {
    const save = jest.fn().mockResolvedValue(undefined);
    const store = {
      claim: jest.fn().mockResolvedValue('lock'),
      getJob: jest.fn().mockResolvedValue(record),
      save,
      release: jest.fn().mockResolvedValue(undefined),
    };
    const send = jest.fn().mockResolvedValue({
      kind: 'accepted',
      groupId: 'new-group',
      messageId: 'new-message',
    });
    const delivery = jest
      .fn()
      .mockResolvedValue({ kind: 'delivered', code: '4000' });
    const sender: GroupMessageSender = {
      send,
      delivery,
    };
    const config = createAppConfig({
      adminGroupMessaging: {
        enabled,
        internalToken: 'g'.repeat(32),
        previewTtlSeconds: 1800,
        authorizationTtlSeconds: 300,
        retentionSeconds: 2592000,
        kakao: {
          enabled: true,
          pfId: 'pf-id',
          templates: [
            {
              id: 'template',
              name: '안내',
              providerTemplateId: 'provider-template',
              content: '#{이름}님 안내',
              variableMapping: { name: '#{이름}' },
            },
          ],
        },
      },
    });
    return {
      store,
      sender,
      send,
      delivery,
      save,
      service: new AdminGroupMessageService(
        config,
        store as unknown as AdminGroupMessageStore,
        sender,
        new KakaoSenderProvider(config),
      ),
    };
  }

  afterEach(() => jest.restoreAllMocks());

  describe('KAKAO job은 문자와 카톡을 둘 다 보낸다', () => {
    const kakaoJob = (fallbackToSms?: boolean): GroupMessageJob => ({
      ...job([
        {
          ...target('PENDING'),
          content: '김학생님 안내',
          templateVariables: { name: '김학생' },
        },
      ]),
      channel: 'KAKAO',
      templateId: 'template',
      fallbackToSms,
    });
    const savedTarget = (save: jest.Mock) =>
      (save.mock.calls as [GroupMessageJob][]).at(-1)?.[0].targets[0];

    it.each([undefined, false, true])(
      'fallbackToSms=%s여도 문자 접수·저장 뒤 같은 문구의 카톡(disableSms: true)을 한 건 보낸다',
      async (fallbackToSms) => {
        const record = kakaoJob(fallbackToSms);
        const { service, send, save } = setup(record);
        const fetch = mockKakaoFetch();

        await service.process(record.jobId);

        expect(send).toHaveBeenCalledTimes(1);
        const [[, sending]] = send.mock.calls as [
          GroupMessageJob,
          GroupMessageJob['targets'][number],
        ][];
        expect(sentKakaoMessages(fetch)).toEqual([
          {
            to: '01012345678',
            from: createAppConfig().sms.fromStandardNumber,
            text: '김학생님 안내',
            kakaoOptions: {
              pfId: 'pf-id',
              templateId: 'provider-template',
              variables: { '#{이름}': '김학생' },
              disableSms: true,
            },
            customFields: {
              jobId: record.jobId,
              targetId: sending.targetId,
              attemptId: sending.attemptId,
            },
          },
        ]);
        expect(save.mock.invocationCallOrder.at(-1)).toBeLessThan(
          fetch.mock.invocationCallOrder[0],
        );
        expect(savedTarget(save)).toMatchObject({
          status: 'ACCEPTED',
          messageId: 'new-message',
        });
      },
    );

    it.each(['failed', 'network-error'] as const)(
      '카톡이 실패해도(%s) 문자 기준으로 ACCEPTED다',
      async (outcome) => {
        const record = kakaoJob();
        const { service, save } = setup(record);
        mockKakaoFetch(outcome);

        await expect(service.process(record.jobId)).resolves.toBe(false);
        expect(savedTarget(save)).toMatchObject({
          status: 'ACCEPTED',
          messageId: 'new-message',
        });
      },
    );

    it.each([
      [{ kind: 'rejected', code: '3059' }, 'FAILED'],
      [{ kind: 'unknown' }, 'UNKNOWN'],
    ])(
      '문자가 실패하면(%o) 지금처럼 %s이고 카톡은 보내지 않는다',
      async (receipt, status) => {
        const record = kakaoJob();
        const { service, send, save } = setup(record);
        send.mockResolvedValue(receipt);
        const fetch = mockKakaoFetch();

        await service.process(record.jobId);

        expect(savedTarget(save)).toMatchObject({ status });
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it('SMS job은 카톡을 보내지 않는다', async () => {
      const record = job([target('PENDING')]);
      const { service } = setup(record);
      const fetch = mockKakaoFetch();

      await service.process(record.jobId);

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('marks an interrupted SENDING request unknown without sending again', async () => {
    const record = job([target('SENDING')]);
    const { service, save, send } = setup(record);
    await expect(service.process(record.jobId)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ATTENTION',
        targets: [
          expect.objectContaining({
            status: 'UNKNOWN',
            failureReason: 'PROVIDER_ACCEPTANCE_UNKNOWN',
          }),
        ],
      }),
      'lock',
    );
  });

  it('sends pending targets before polling accepted targets', async () => {
    const record = job([target('ACCEPTED'), target('PENDING')]);
    const { service, send, delivery } = setup(record);
    await service.process(record.jobId);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetId: 'target-PENDING' }),
    );
    expect(delivery).not.toHaveBeenCalled();
  });

  it('pauses pending work when the channel is disabled immediately before send', async () => {
    const record = job([target('PENDING')]);
    const { service, save, send } = setup(record, false);
    await service.process(record.jobId);
    expect(send).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PAUSED',
        reason: 'CHANNEL_CONFIGURATION_UNAVAILABLE',
      }),
      'lock',
      0,
    );
  });

  it('accepts 900 Unicode Kakao characters and rejects 1001 after substitution', async () => {
    const createPreview = jest.fn();
    const store = { createPreview };
    const sender: GroupMessageSender = {
      send: jest.fn(),
      delivery: jest.fn(),
    };
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
              id: 'template',
              name: '안내',
              providerTemplateId: 'provider-template',
              content: '#{이름}',
              variableMapping: { name: '#{이름}' },
            },
          ],
        },
      },
    });
    const service = new AdminGroupMessageService(
      config,
      store as unknown as AdminGroupMessageStore,
      sender,
      new KakaoSenderProvider(config),
    );
    const input = (content: string): CreateGroupMessagePreview => ({
      requesterUserId: 1,
      expoId: randomUUID(),
      requestId: randomUUID(),
      applicationCount: 1,
      targetFingerprint: 'c'.repeat(64),
      channel: 'KAKAO',
      templateId: 'template',
      fallbackToSms: false,
      targets: [
        {
          targetId: 'participant',
          applicationId: randomUUID(),
          participantId: 1,
          programType: 'STANDARD',
          recipientPhone: '01012345678',
          content,
          templateVariables: { name: content },
        },
      ],
    });
    const accepted = input('가'.repeat(900));
    createPreview.mockResolvedValue({
      ...accepted,
      previewId: randomUUID(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(service.createPreview(accepted)).resolves.toBeDefined();
    await expect(
      service.createPreview(input('가'.repeat(1001))),
    ).rejects.toThrow('Kakao message exceeds 1000 characters');
  });
});
