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
import type {
  GroupKakaoTemplate,
  GroupMessageSender,
} from './group-message-sender.interface';

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

  const nameTemplate: GroupKakaoTemplate = {
    id: 'template',
    name: '안내',
    providerTemplateId: 'provider-template',
    content: '#{이름}님 안내',
    variableMapping: { name: '#{이름}' },
    fixedVariables: {},
  };

  function setup(
    record: GroupMessageJob,
    enabled = true,
    template: GroupKakaoTemplate = nameTemplate,
  ) {
    const save = jest.fn().mockResolvedValue(undefined);
    // 호출 시점 상태를 남긴다(처리 중 같은 객체를 계속 바꾸므로).
    const targetSnapshots: string[] = [];
    const saveTarget = jest
      .fn()
      .mockImplementation(
        (_jobId: string, _token: string, saved: { status: string }) => {
          targetSnapshots.push(saved.status);
          return Promise.resolve();
        },
      );
    const store = {
      claim: jest.fn().mockResolvedValue('lock'),
      getJob: jest.fn().mockResolvedValue(record),
      save,
      saveTarget,
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
          templates: [template],
        },
      },
    });
    return {
      store,
      sender,
      send,
      delivery,
      save,
      saveTarget,
      targetSnapshots,
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
        const { service, send, save, saveTarget } = setup(record);
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
        expect(saveTarget.mock.invocationCallOrder.at(-1)).toBeLessThan(
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

    it('받는 사람별 링크·신청 내역과 고정값을 카톡 변수에 넣는다', async () => {
      const content = '#{이름}님 #{신청내역}\nQR: #{URL}\n주차: #{주차장URL}';
      const text =
        '김학생님 1일차 오전\nQR: https://expo.example/qr/1\n주차: https://glink.kr/busy';
      const record: GroupMessageJob = {
        ...job([
          {
            ...target('PENDING'),
            content: text,
            templateVariables: {
              name: '김학생',
              applicationSummary: '1일차 오전',
              applicationUrl: 'https://expo.example/qr/1',
            },
          },
        ]),
        channel: 'KAKAO',
        templateId: 'template',
      };
      const { service, send } = setup(record, true, {
        ...nameTemplate,
        content,
        variableMapping: {
          name: '#{이름}',
          applicationSummary: '#{신청내역}',
          applicationUrl: '#{URL}',
        },
        fixedVariables: { '#{주차장URL}': 'https://glink.kr/busy' },
      });
      const fetch = mockKakaoFetch();

      await service.process(record.jobId);

      expect(send).toHaveBeenCalledTimes(1);
      expect(sentKakaoMessages(fetch)).toMatchObject([
        {
          text,
          kakaoOptions: {
            variables: {
              '#{이름}': '김학생',
              '#{신청내역}': '1일차 오전',
              '#{URL}': 'https://expo.example/qr/1',
              '#{주차장URL}': 'https://glink.kr/busy',
            },
          },
        },
      ]);
    });

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

  it('여러 대상을 한 묶음으로 처리하며 대상마다 전체 job이 아니라 대상 1건만 저장한다', async () => {
    const targets = [1, 2, 3].map((n) => ({
      ...target('PENDING'),
      targetId: `target-${n}`,
    }));
    const record = job(targets);
    const { service, send, save, saveTarget, store, targetSnapshots } =
      setup(record);
    await expect(service.process(record.jobId)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(store.getJob).toHaveBeenCalledTimes(1);
    // 대상마다 SENDING, 결과 두 번. 전체 저장은 묶음 끝에 한 번.
    expect(saveTarget).toHaveBeenCalledTimes(6);
    expect(save).toHaveBeenCalledTimes(1);
    const sendingOrder = saveTarget.mock.invocationCallOrder[0];
    expect(sendingOrder).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(targetSnapshots).toEqual(
      targets.flatMap(() => ['SENDING', 'ACCEPTED']),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'RUNNING',
        targets: [
          expect.objectContaining({ status: 'ACCEPTED' }),
          expect.objectContaining({ status: 'ACCEPTED' }),
          expect.objectContaining({ status: 'ACCEPTED' }),
        ],
      }),
      'lock',
    );
  });

  it('묶음 크기를 넘는 대기 대상은 남겨 두고 true를 돌려준다', async () => {
    const record = job(
      Array.from({ length: 25 }, (_, n) => ({
        ...target('PENDING'),
        targetId: `target-${n}`,
      })),
    );
    const { service, send } = setup(record);
    await expect(service.process(record.jobId)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(20);
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
              fixedVariables: {},
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
