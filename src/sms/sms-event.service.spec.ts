import { ExpoNameProvider } from '../common/expo-name.provider';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import {
  mockKakaoFetch,
  sentKakaoMessages,
} from '../../test/fixtures/kakao-fetch.fixture';
import { KakaoSenderProvider } from './kakao-sender.provider';
import {
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { SmsEvent } from './sms-event.schema';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsEventService } from './sms-event.service';
import { SmsSenderProvider } from './sms-sender.provider';

const config = createAppConfig();

const drawResult: SmsEvent = {
  eventId: 'e1',
  version: 1,
  type: 'DRAW_RESULT',
  phoneNumber: '01012345678',
  drawNumber: 3,
};

const custom: SmsEvent = {
  eventId: 'e2',
  version: 1,
  type: 'CUSTOM',
  phoneNumbers: ['01011112222', '01033334444'],
  senderType: 'TRAINEE',
  text: '공지',
};

describe('SmsEventService', () => {
  let dedupe: {
    claim: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
    increaseFailureCount: jest.Mock;
    markSending: jest.Mock;
    markUnknown: jest.Mock;
  };
  let sender: { deliver: jest.Mock };
  let titleOf: jest.Mock<Promise<string>, [string | undefined]>;
  let service: SmsEventService;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue('claimed'),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      increaseFailureCount: jest.fn().mockResolvedValue(1),
      markSending: jest.fn().mockResolvedValue(undefined),
      markUnknown: jest.fn().mockResolvedValue(undefined),
    };
    sender = {
      deliver: jest.fn().mockResolvedValue({ kind: 'accepted', failedTo: [] }),
    };
    titleOf = jest
      .fn<Promise<string>, [string | undefined]>()
      .mockResolvedValue('광주 박람회');
    service = new SmsEventService(
      config,
      new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore),
      sender as unknown as SmsSenderProvider,
      new KakaoSenderProvider(config),
      { titleOf } as unknown as ExpoNameProvider,
    );
    config.kakao = undefined;
  });

  afterEach(() => jest.restoreAllMocks());

  describe('신청 결과 문자(#110)', () => {
    const result: SmsEvent = {
      eventId: 'r1',
      version: 1,
      type: 'PROGRAM_CONFIRMED',
      phoneNumber: '01012345678',
      expoId: 'expo-1',
      senderType: 'TRAINEE',
      occurredAt: new Date().toISOString(),
      items: [{ participantName: '홍길동', title: 'AI 코딩 체험' }],
    };

    it('대표자 번호로 유형 문구를 해당 발신번호로 보낸다', async () => {
      await service.handle(result);

      expect(titleOf).toHaveBeenCalledWith('expo-1');
      expect(sender.deliver).toHaveBeenCalledTimes(1);
      const [eventId, messages] = sender.deliver.mock.calls[0] as [
        string,
        { to: string; from: string; text: string }[],
      ];
      expect(eventId).toBe('r1');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        to: '01012345678',
        from: config.sms.fromTraineeNumber,
      });
      expect(messages[0].text).toContain(
        '[광주 박람회] 프로그램 신청 확정 안내',
      );
    });

    it('알림톡 설정이 있어도 문자로만 보낸다', async () => {
      config.kakao = {
        pfId: 'pf',
        auto: { drawResult: 'tpl' },
      };
      const fetchMock = mockKakaoFetch();

      await service.handle(result);

      expect(sentKakaoMessages(fetchMock)).toHaveLength(0);
    });

    it('같은 eventId가 이미 끝났으면 다시 보내지 않는다', async () => {
      dedupe.claim.mockResolvedValue('done');

      await service.handle(result);

      expect(sender.deliver).not.toHaveBeenCalled();
    });

    it('접수 결과 불명이면 던지고 자동 재발송하지 않는다', async () => {
      sender.deliver.mockResolvedValue({ kind: 'unknown' });

      await expect(service.handle(result)).rejects.toBeInstanceOf(
        SmsDeliveryUnknownError,
      );
      expect(dedupe.release).not.toHaveBeenCalled();
    });

    it('공급자가 거절하면 선점을 풀고 던진다', async () => {
      sender.deliver.mockResolvedValue({ kind: 'rejected', code: 'X' });

      await expect(service.handle(result)).rejects.toBeInstanceOf(
        SmsDeliveryRejectedError,
      );
      expect(dedupe.release).toHaveBeenCalledWith('r1');
    });

    it('허용 박람회가 아니면 선점도 발송도 하지 않는다', async () => {
      config.sms.applicationResult = {
        expoIds: ['test-expo'],
        maxAgeSeconds: 60,
      };

      await service.handle(result);

      expect(dedupe.claim).not.toHaveBeenCalled();
      expect(sender.deliver).not.toHaveBeenCalled();
      config.sms.applicationResult = { maxAgeSeconds: 86_400 };
    });

    it('허용 박람회면 보낸다', async () => {
      config.sms.applicationResult = { expoIds: ['expo-1'], maxAgeSeconds: 60 };

      await service.handle(result);

      expect(sender.deliver).toHaveBeenCalledTimes(1);
      config.sms.applicationResult = { maxAgeSeconds: 86_400 };
    });

    it('본문이 2000바이트를 넘으면 보내지 않고 재시도하지 않는다', async () => {
      const long = '가'.repeat(100);

      await service.handle({
        ...result,
        items: Array.from({ length: 10 }, () => ({
          participantName: long,
          title: long,
          location: long,
        })),
      });

      expect(sender.deliver).not.toHaveBeenCalled();
      expect(dedupe.complete).toHaveBeenCalledWith('r1');
    });

    it('오래된 이벤트는 소급 발송하지 않는다', async () => {
      await service.handle({
        ...result,
        occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      });

      expect(sender.deliver).not.toHaveBeenCalled();
    });
  });

  describe('알림톡(K4)', () => {
    const text = [
      '[광주 박람회] 행운의 숫자 당첨 안내',
      '',
      '축하합니다! 🎉',
      "설문조사 이벤트 '행운의 숫자'에 당첨되셨습니다.",
      '',
      '▶ 당첨 번호: 3번',
      '▶ 경품 수령 장소: 입구 운영본부',
      '',
      '※ 본 메시지는 광주 박람회 설문 참여자 중 당첨자에게 발송되었습니다.',
    ].join('\n');

    it('DRAW_RESULT templateId가 있으면 문자 한 건과 카톡(disableSms: true) 한 건을 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { drawResult: 'k4' } };
      const fetch = mockKakaoFetch();

      await service.handle({ ...drawResult, expoId: 'expo-1' });

      const sms = {
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text,
      };
      expect(
        (sender.deliver.mock.calls[0] as [string, unknown])[1],
      ).toStrictEqual([sms]);
      expect(sentKakaoMessages(fetch)).toEqual([
        {
          ...sms,
          kakaoOptions: {
            pfId: 'pf-1',
            templateId: 'k4',
            variables: {
              '#{행사명}': '광주 박람회',
              '#{번호}': '3',
              '#{장소}': '입구 운영본부',
            },
            disableSms: true,
          },
          customFields: { eventId: 'e1' },
        },
      ]);
      expect(titleOf).toHaveBeenCalledWith('expo-1');
      expect(dedupe.complete).toHaveBeenCalledWith('e1');
    });

    it.each(['failed', 'network-error'] as const)(
      '카톡이 실패해도(%s) 문자가 접수되면 완료 처리하고 던지지 않는다',
      async (outcome) => {
        config.kakao = { pfId: 'pf-1', auto: { drawResult: 'k4' } };
        mockKakaoFetch(outcome);

        await expect(service.handle(drawResult)).resolves.toBeUndefined();
        expect(dedupe.complete).toHaveBeenCalledWith('e1');
        expect(dedupe.markUnknown).not.toHaveBeenCalled();
        expect(dedupe.release).not.toHaveBeenCalled();
      },
    );

    it.each([
      [{ kind: 'rejected', code: '3059' }, SmsDeliveryRejectedError],
      [{ kind: 'unknown' }, SmsDeliveryUnknownError],
    ])(
      '문자가 실패하면(%o) 지금처럼 던지고 카톡은 보내지 않는다',
      async (receipt, error) => {
        config.kakao = { pfId: 'pf-1', auto: { drawResult: 'k4' } };
        const fetch = mockKakaoFetch();
        sender.deliver.mockResolvedValue(receipt);

        await expect(service.handle(drawResult)).rejects.toBeInstanceOf(error);
        expect(fetch).not.toHaveBeenCalled();
        expect(dedupe.complete).not.toHaveBeenCalled();
      },
    );

    it('templateId가 없으면 kakaoOptions 없이 같은 문구를 문자로 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { authCode: 'k1' } };

      await service.handle(drawResult);

      expect(
        (sender.deliver.mock.calls[0] as [string, unknown])[1],
      ).toStrictEqual([
        { to: '01012345678', from: config.sms.fromStandardNumber, text },
      ]);
    });

    it('CUSTOM은 templateId 설정과 무관하게 문자로만 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { drawResult: 'k4' } };

      await service.handle(custom);

      expect(
        (sender.deliver.mock.calls[0] as [string, unknown])[1],
      ).toStrictEqual([
        { to: '01011112222', from: config.sms.fromTraineeNumber, text: '공지' },
        { to: '01033334444', from: config.sms.fromTraineeNumber, text: '공지' },
      ]);
    });
  });

  it('이벤트를 문자로 렌더링해 일반 참가자 발신번호로 발송한다', async () => {
    await service.handle(drawResult);

    expect(sender.deliver).toHaveBeenCalledWith('e1', [
      expect.objectContaining({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: expect.stringContaining('▶ 당첨 번호: 3번') as string,
      }),
    ]);
  });

  it('TRAINEE 이벤트는 연수생 발신번호를 쓰고 수신자마다 한 건씩 보낸다', async () => {
    await service.handle(custom);

    expect(sender.deliver).toHaveBeenCalledWith('e2', [
      { to: '01011112222', from: config.sms.fromTraineeNumber, text: '공지' },
      { to: '01033334444', from: config.sms.fromTraineeNumber, text: '공지' },
    ]);
    // CUSTOM은 행사명을 쓰지 않아 Expo를 조회하지 않는다.
    expect(titleOf).toHaveBeenCalledWith(undefined);
  });

  it('발송에 성공하면 claim을 완료 마커로 승격한다', async () => {
    await service.handle(drawResult);

    expect(dedupe.markSending).toHaveBeenCalledWith('e1');
    expect(dedupe.markSending.mock.invocationCallOrder[0]).toBeLessThan(
      sender.deliver.mock.invocationCallOrder[0],
    );
    expect(dedupe.complete).toHaveBeenCalledWith('e1');
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('같은 대표 번호의 서로 다른 연수자 이벤트는 각각 발송하고 재전달은 억제한다', async () => {
    const claimed = new Set<string>();
    dedupe.claim.mockImplementation((eventId: string) => {
      if (claimed.has(eventId)) return Promise.resolve('done');
      claimed.add(eventId);
      return Promise.resolve('claimed');
    });
    const first: SmsEvent = {
      ...custom,
      eventId: 'application-trainee-101',
      phoneNumbers: ['01011112222'],
      text: '연수자 101 신청 완료',
    };
    const second: SmsEvent = {
      ...first,
      eventId: 'application-trainee-102',
      text: '연수자 102 신청 완료',
    };

    await service.handle(first);
    await service.handle(second);
    await service.handle(first);
    await service.handle(second);

    expect(sender.deliver).toHaveBeenCalledTimes(2);
    expect(sender.deliver).toHaveBeenNthCalledWith(1, first.eventId, [
      {
        to: '01011112222',
        from: config.sms.fromTraineeNumber,
        text: first.text,
      },
    ]);
    expect(sender.deliver).toHaveBeenNthCalledWith(2, second.eventId, [
      {
        to: '01011112222',
        from: config.sms.fromTraineeNumber,
        text: second.text,
      },
    ]);
    expect(dedupe.complete.mock.calls).toEqual([
      [first.eventId],
      [second.eventId],
    ]);
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('claim 해제가 실패해도 원래 에러를 그대로 던진다', async () => {
    sender.deliver.mockResolvedValue({ kind: 'rejected', code: '3059' });
    dedupe.release.mockRejectedValue(new Error('redis down'));

    await expect(service.handle(drawResult)).rejects.toBeInstanceOf(
      SmsDeliveryRejectedError,
    );
  });

  it('이미 처리한 eventId는 발송하지 않는다', async () => {
    dedupe.claim.mockResolvedValue('done');

    await service.handle(drawResult);

    expect(sender.deliver).not.toHaveBeenCalled();
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('다른 곳에서 처리 중이면 보내지 않고 던진다 (조용히 버리면 선점을 쥔 쪽이 죽었을 때 유실)', async () => {
    dedupe.claim.mockResolvedValue('in-progress');

    await expect(service.handle(drawResult)).rejects.toThrow('being processed');
    expect(sender.deliver).not.toHaveBeenCalled();
  });

  it('명시적 거부(전부 미접수)면 claim을 풀고 던져서 제한 재시도되게 한다', async () => {
    sender.deliver.mockResolvedValue({ kind: 'rejected', code: '3059' });

    await expect(service.handle(drawResult)).rejects.toBeInstanceOf(
      SmsDeliveryRejectedError,
    );
    expect(dedupe.release).toHaveBeenCalledWith('e1');
    expect(dedupe.markUnknown).not.toHaveBeenCalled();
  });

  it('접수 후 응답 유실(unknown)이면 claim을 풀지 않고 UNKNOWN으로 남겨 같은 eventId 재전달에서 다시 보내지 않는다', async () => {
    const state = new Map<string, string>();
    dedupe.claim.mockImplementation((id: string) =>
      Promise.resolve(
        state.get(id) === 'sending' || state.get(id) === 'unknown'
          ? 'unknown'
          : 'claimed',
      ),
    );
    dedupe.markSending.mockImplementation((id: string) => {
      state.set(id, 'sending');
      return Promise.resolve();
    });
    dedupe.markUnknown.mockImplementation((id: string) => {
      state.set(id, 'unknown');
      return Promise.resolve();
    });
    dedupe.release.mockImplementation((id: string) => {
      state.delete(id);
      return Promise.resolve();
    });
    sender.deliver.mockResolvedValue({ kind: 'unknown' });

    await expect(service.handle(drawResult)).rejects.toBeInstanceOf(
      SmsDeliveryUnknownError,
    );
    await expect(service.handle(drawResult)).rejects.toBeInstanceOf(
      SmsDeliveryUnknownError,
    );

    expect(sender.deliver).toHaveBeenCalledTimes(1);
    expect(dedupe.release).not.toHaveBeenCalled();
    expect(state.get('e1')).toBe('unknown');
  });

  it('발송 전 단계(SENDING 기록) 실패는 미발송이라 claim을 풀고 그대로 전파한다', async () => {
    dedupe.markSending.mockRejectedValue(new Error('redis down'));

    await expect(service.handle(drawResult)).rejects.toThrow('redis down');
    expect(sender.deliver).not.toHaveBeenCalled();
    expect(dedupe.release).toHaveBeenCalledWith('e1');
  });

  it('일부만 실패하면 던지지 않고 완료 처리한다 (접수된 수신자 중복 발송 방지)', async () => {
    sender.deliver.mockResolvedValue({
      kind: 'accepted',
      failedTo: ['01033334444'],
    });

    await expect(service.handle(custom)).resolves.toBeUndefined();
    expect(dedupe.release).not.toHaveBeenCalled();
    expect(dedupe.complete).toHaveBeenCalledWith('e2');
  });
});
