import { Logger } from '@nestjs/common';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import {
  mockKakaoFetch,
  sentKakaoMessages,
} from '../../test/fixtures/kakao-fetch.fixture';
import { KakaoSenderProvider } from '../sms/kakao-sender.provider';
import type { ExpoNameProvider } from '../common/expo-name.provider';
import type { PromotionApplicationProvider } from './promotion-application.provider';
import type { PromotionSolapiProvider } from './promotion-solapi.provider';
import {
  PromotionInvalidCheckError,
  PromotionRetryError,
} from './promotion.schema';
import type { PromotionCheck, PromotionRecord } from './promotion.schema';
import { PromotionService } from './promotion.service';
import type { PromotionStore } from './promotion.store';

const event = {
  version: 1 as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  expoId: '33333333-3333-4333-8333-333333333333',
  participantId: 1,
  programType: 'STANDARD' as const,
  programId: 2,
};
const check: PromotionCheck = {
  ...event,
  eligible: true,
  status: 'CONFIRMED',
  representativePhoneNumber: '01012345678',
  participantName: '홍길동',
  programName: '미래 수업',
  startedAt: '2026-10-31T01:00:00Z',
  endedAt: '2026-10-31T02:00:00Z',
  location: null,
  applicationLookupUrl: null,
};
const text = [
  '[광주 박람회] 프로그램 대기 승급 안내',
  '홍길동님의 프로그램 신청이 확정되었습니다.',
  '프로그램: 미래 수업',
  '일시: 2026. 10. 31. 10:00 ~ 2026. 10. 31. 11:00 (한국시간)',
  '장소: 추후 안내',
  '신청 조회: 신청시스템에서 확인해 주세요',
].join('\n');

describe('PromotionService 승급 안내(K3)', () => {
  const config = createAppConfig();
  const send = jest.fn<
    ReturnType<PromotionSolapiProvider['send']>,
    Parameters<PromotionSolapiProvider['send']>
  >();
  const titleOf = jest.fn<Promise<string>, [string | undefined]>();
  let service: PromotionService;
  let save: jest.Mock<Promise<void>, [PromotionRecord, string]>;

  beforeEach(() => {
    config.kakao = undefined;
    send.mockReset().mockResolvedValue({ kind: 'unknown' });
    titleOf.mockReset().mockResolvedValue('광주 박람회');
    const record: PromotionRecord = { event, status: 'PENDING', failures: 0 };
    const store = {
      claim: jest.fn().mockResolvedValue('token'),
      get: jest.fn().mockResolvedValue(record),
      save: (save = jest
        .fn<Promise<void>, [PromotionRecord, string]>()
        .mockResolvedValue(undefined)),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new PromotionService(
      config,
      store as unknown as PromotionStore,
      {
        check: jest.fn().mockResolvedValue(check),
      } as unknown as PromotionApplicationProvider,
      { send } as unknown as PromotionSolapiProvider,
      { titleOf } as unknown as ExpoNameProvider,
      new KakaoSenderProvider(config),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('박람회 제목과 빈 장소·조회 주소 대체 문구로 문자로만 보낸다', async () => {
    await service.process(event.eventId);

    expect(titleOf).toHaveBeenCalledWith(event.expoId);
    expect(send.mock.calls[0]?.[1]).toStrictEqual({
      to: '01012345678',
      from: config.sms.fromStandardNumber,
      text,
    });
  });

  const accepted = {
    kind: 'accepted',
    groupId: 'group-1',
    messageId: 'message-1',
  } as const;
  const statuses = () => save.mock.calls.map(([record]) => record.status);

  it('templateId가 있으면 문자를 보내 ACCEPTED를 저장한 뒤 같은 문구의 카톡(disableSms: true)을 한 건 보낸다', async () => {
    config.kakao = { pfId: 'pf-1', auto: { promotion: 'k3' } };
    send.mockResolvedValue(accepted);
    const fetch = mockKakaoFetch();

    await service.process(event.eventId);

    const sms = {
      to: '01012345678',
      from: config.sms.fromStandardNumber,
      text,
    };
    expect(send.mock.calls[0]?.[1]).toStrictEqual(sms);
    const sending = send.mock.calls[0]?.[0] as PromotionRecord;
    expect(sentKakaoMessages(fetch)).toEqual([
      {
        ...sms,
        kakaoOptions: {
          pfId: 'pf-1',
          templateId: 'k3',
          disableSms: true,
          variables: {
            '#{행사명}': '광주 박람회',
            '#{이름}': '홍길동',
            '#{프로그램}': '미래 수업',
            '#{일시}': '2026. 10. 31. 10:00 ~ 2026. 10. 31. 11:00 (한국시간)',
            '#{장소}': '추후 안내',
            '#{신청조회}': '신청시스템에서 확인해 주세요',
          },
        },
        customFields: { eventId: event.eventId, attemptId: sending.attemptId },
      },
    ]);
    expect(statuses()).toEqual(['SENDING', 'ACCEPTED']);
    expect(save.mock.invocationCallOrder[1]).toBeLessThan(
      fetch.mock.invocationCallOrder[0],
    );
  });

  it.each(['failed', 'network-error'] as const)(
    '카톡이 실패해도(%s) 문자 기준으로 ACCEPTED이고 messageId는 문자 것이다',
    async (outcome) => {
      config.kakao = { pfId: 'pf-1', auto: { promotion: 'k3' } };
      send.mockResolvedValue(accepted);
      mockKakaoFetch(outcome);

      await expect(service.process(event.eventId)).resolves.toBeUndefined();

      expect(statuses()).toEqual(['SENDING', 'ACCEPTED']);
      expect(save.mock.calls[1]?.[0]).toMatchObject({
        status: 'ACCEPTED',
        messageId: 'message-1',
      });
    },
  );

  it.each([
    [{ kind: 'rejected', code: '3059' } as const, 'PENDING'],
    [{ kind: 'unknown' } as const, 'UNKNOWN'],
  ])(
    '문자가 실패하면(%o) 지금처럼 %s로 저장하고 카톡은 보내지 않는다',
    async (receipt, status) => {
      config.kakao = { pfId: 'pf-1', auto: { promotion: 'k3' } };
      send.mockResolvedValue(receipt);
      const fetch = mockKakaoFetch();

      await service.process(event.eventId);

      expect(statuses()).toEqual(['SENDING', status]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('PromotionService 복구 보류와 수동 재개(#32)', () => {
  const base: PromotionRecord = { event, status: 'PENDING', failures: 0 };
  const setup = (record: PromotionRecord | null, recoveryHold = false) => {
    const config = createAppConfig({
      promotion: {
        enabled: true,
        application: {
          baseUrl: 'http://application.test',
          internalToken: 'a'.repeat(32),
        },
        internalToken: 'o'.repeat(32),
        topic: 'promotion.test',
        groupId: 'promotion.test',
        recoveryHold,
      },
    });
    const store = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      claim: jest.fn().mockResolvedValue('token'),
      get: jest.fn().mockResolvedValue(record),
      save: jest
        .fn<Promise<void>, [PromotionRecord, string]>()
        .mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const check = jest.fn().mockResolvedValue(check2);
    const send = jest.fn();
    const service = new PromotionService(
      config,
      store as unknown as PromotionStore,
      { check } as unknown as PromotionApplicationProvider,
      { send } as unknown as PromotionSolapiProvider,
      { titleOf: jest.fn() } as unknown as ExpoNameProvider,
      new KakaoSenderProvider(config),
    );
    return { service, store, check, send };
  };
  const check2 = check;

  it('보류 중에는 수신 기록만 하고 조회·발송하지 않는다', async () => {
    const { service, store, check, send } = setup(base, true);

    await service.handle(event);
    await service.process(event.eventId);

    expect(store.enqueue).toHaveBeenCalledWith(event);
    expect(check).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...base, status: 'UNKNOWN' as const, attemptId: event.applicationId }],
    [{ ...base, status: 'SENDING' as const }],
    [{ ...base, status: 'OPERATIONS' as const, failures: 5 }],
  ])(
    '%o는 승인 근거와 함께 PENDING으로 재개하고 이력을 남긴다',
    async (record) => {
      const { service, store, send } = setup(record);

      await expect(service.resume(event.eventId, 'OPS-1')).resolves.toBe(
        'RESUMED',
      );

      const saved = store.save.mock.calls[0]?.[0];
      expect(saved).toMatchObject({
        status: 'PENDING',
        failures: 0,
        reason: 'MANUAL_RESUME',
        resumes: [
          {
            approvalRef: 'OPS-1',
            fromStatus: record.status,
            fromAttemptId: record.attemptId,
          },
        ],
      });
      expect(saved?.attemptId).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ ...base, status: 'UNKNOWN' as const, messageId: 'm-1' }],
    [{ ...base, status: 'ACCEPTED' as const, messageId: 'm-1' }],
    [{ ...base, status: 'DELIVERED' as const }],
    [base],
  ])('%o는 재개하지 않는다', async (record) => {
    const { service, store } = setup(record);

    await expect(service.resume(event.eventId, 'OPS-1')).resolves.toBe(
      'NOT_RESUMABLE',
    );
    expect(store.save).not.toHaveBeenCalled();
  });

  it('check 응답이 계약과 다르면 다시 조회하지 않고 OPERATIONS로 끝내며 로그를 한 번 남긴다(#95)', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, store, check, send } = setup(base);
    check.mockRejectedValue(new PromotionInvalidCheckError());

    await service.process(event.eventId);

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save.mock.calls[0]?.[0]).toMatchObject({
      status: 'OPERATIONS',
      reason: 'INVALID_CHECK_RESPONSE',
    });
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('일시 조회 장애는 PENDING으로 남겨 다시 조회한다', async () => {
    const { service, store, check } = setup(base);
    check.mockRejectedValue(new PromotionRetryError());

    await service.process(event.eventId);

    expect(store.save.mock.calls[0]?.[0]).toMatchObject({
      status: 'PENDING',
      reason: 'LOOKUP_UNAVAILABLE',
    });
  });

  it('선점 중이면 BUSY, 기록이 없으면 NOT_FOUND', async () => {
    const busy = setup(base);
    busy.store.claim.mockResolvedValue(null);
    await expect(busy.service.resume(event.eventId, 'OPS-1')).resolves.toBe(
      'BUSY',
    );
    await expect(
      setup(null).service.resume(event.eventId, 'OPS-1'),
    ).resolves.toBe('NOT_FOUND');
  });
});
