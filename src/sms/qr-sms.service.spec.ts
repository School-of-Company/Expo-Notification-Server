import { Test } from '@nestjs/testing';
import { ExpoNameProvider } from '../common/expo-name.provider';
import { APP_CONFIG } from '../config/app-config.constants';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { FakeRedis } from '../../test/fixtures/fake-redis';
import {
  isSolapiUrl,
  solapiSendManyResponse,
  type SolapiOutgoing,
} from '../../test/fixtures/solapi-fetch.fixture';
import { KakaoSenderProvider } from './kakao-sender.provider';
import type { ParticipantRegisteredEvent } from './participant-event.schema';
import { ParticipantNamesProvider } from './participant-names.provider';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { QrSmsService } from './qr-sms.service';
import {
  EventInProgressError,
  QrLinkError,
  SentEventPublishError,
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsSenderProvider } from './sms-sender.provider';
import { SOLAPI_CLIENT } from './sms.constants';

const standard: ParticipantRegisteredEvent = {
  eventId: 'e1',
  expoId: 'expo-1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '01012345678',
  participants: [{ id: 42, code: 'a'.repeat(22) }],
};

describe('QrSmsService', () => {
  const config = createAppConfig();
  let redis: FakeRedis;
  let service: QrSmsService;
  let store: SmsEventDedupeStore;
  const send = jest.fn<
    Promise<{ failedMessageList: { to: string }[] }>,
    [SolapiOutgoing[]]
  >();
  const publish = jest.fn<Promise<void>, [unknown]>();
  const titleOf = jest.fn<Promise<string>, [string | undefined]>();
  // 이름 조회 응답만 흉내 낸다. Solapi 호출은 아래 globalFetch가 send 가짜로 돌린다 (실제 접속 없음).
  const fetchSpy = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
  const globalFetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) =>
      isSolapiUrl(input)
        ? solapiSendManyResponse(init, send)
        : fetchSpy(input, init),
    );

  beforeEach(async () => {
    config.sms = { ...createAppConfig().sms };
    redis = new FakeRedis();
    send.mockReset().mockResolvedValue({ failedMessageList: [] });
    publish.mockReset().mockResolvedValue(undefined);
    titleOf.mockReset().mockResolvedValue('광주 박람회');
    config.kakao = undefined;
    fetchSpy
      .mockReset()
      .mockResolvedValue(
        Response.json([{ participantId: 42, name: '홍길동' }]),
      );
    const module = await Test.createTestingModule({
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: SOLAPI_CLIENT, useValue: { send } },
        { provide: QrSmsSentPublisher, useValue: { publish } },
        { provide: ExpoNameProvider, useValue: { titleOf } },
        SmsEventDedupeStore,
        SmsEventGuard,
        ParticipantNamesProvider,
        SmsSenderProvider,
        KakaoSenderProvider,
        QrSmsService,
      ],
    }).compile();
    service = module.get(QrSmsService);
    store = module.get(SmsEventDedupeStore);
  });
  afterAll(() => globalFetch.mockRestore());
  const text = () => send.mock.calls[0]?.[0][0]?.text ?? '';

  describe('알림톡(K2)', () => {
    const expected =
      '광주 박람회 등록이 완료되었습니다.\n입장할 때 아래 QR 링크를 입구에서 보여 주세요.\n\n' +
      '▶ 신청 확인(QR확인): https://expo.test/qr?expoId=expo-1&type=STANDARD&id=42&code=' +
      'a'.repeat(22) +
      '\n\n※ 본 메시지는 2026 AI미래교육박람회 신청자에게 발송되었습니다.';

    it('templateId가 있으면 문자를 먼저 보내고 같은 문구의 카톡(disableSms: true)을 따로 한 건 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { qrRegistered: 'k2' } };

      await service.handle(standard);

      const sms = {
        to: standard.phoneNumber,
        from: config.sms.fromStandardNumber,
        text: expected,
      };
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0]).toStrictEqual([sms]);
      expect(send.mock.calls[1]?.[0]).toEqual([
        {
          ...sms,
          kakaoOptions: {
            pfId: 'pf-1',
            templateId: 'k2',
            disableSms: true,
            variables: {
              '#{행사명}': '광주 박람회',
              '#{URL}':
                'https://expo.test/qr?expoId=expo-1&type=STANDARD&id=42&code=' +
                'a'.repeat(22),
            },
          },
        },
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'failed',
        () =>
          send.mockResolvedValueOnce({
            failedMessageList: [{ to: standard.phoneNumber }],
          }),
      ],
      [
        'network-error',
        () => send.mockRejectedValueOnce(new Error('kakao socket hang up')),
      ],
    ])(
      '카톡이 실패해도(%s) 문자가 접수되면 완료하고 재전달에도 문자·카톡을 다시 보내지 않는다',
      async (_, failKakao) => {
        config.kakao = { pfId: 'pf-1', auto: { qrRegistered: 'k2' } };
        send.mockResolvedValueOnce({ failedMessageList: [] });
        failKakao();

        await expect(service.handle(standard)).resolves.toBeUndefined();
        await service.handle(standard);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0]?.[0][0]).not.toHaveProperty('kakaoOptions');
        expect(await redis.get('sms:event:e1')).not.toBe('unknown');
        expect(publish).toHaveBeenCalledTimes(1);
      },
    );

    it('문자가 거부되면 지금처럼 던지고 카톡은 보내지 않는다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { qrRegistered: 'k2' } };
      send.mockResolvedValueOnce({
        failedMessageList: [{ to: standard.phoneNumber }],
      });

      await expect(service.handle(standard)).rejects.toBeInstanceOf(
        SmsDeliveryRejectedError,
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
    });

    it('templateId가 없으면 kakaoOptions 없이 같은 문구를 문자로 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: {} };

      await service.handle(standard);

      expect(send.mock.calls[0]?.[0][0]).toStrictEqual({
        to: standard.phoneNumber,
        from: config.sms.fromStandardNumber,
        text: expected,
      });
    });

    it('알림톡 1,000자를 넘으면 kakaoOptions 없이 문자로만 보낸다', async () => {
      config.kakao = { pfId: 'pf-1', auto: { qrRegistered: 'k2' } };
      // 2,000바이트 안이면서 1,000자를 넘는 본문
      titleOf.mockResolvedValue('A'.repeat(1_000));

      await service.handle(standard);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0][0]).not.toHaveProperty('kakaoOptions');
    });
  });

  it('1명 링크를 대표자 번호로 한 통 보내고 개인정보 없는 완료 이벤트를 발행한다', async () => {
    await service.handle(standard);
    expect(send).toHaveBeenCalledWith([
      {
        to: standard.phoneNumber,
        from: config.sms.fromStandardNumber,
        text: text(),
      },
    ]);
    // 링크가 하나면 이름 라벨 없이 URL만 넣는다.
    expect(text()).toContain(
      '▶ 신청 확인(QR확인): https://expo.test/qr?expoId=expo-1&type=STANDARD&id=42&code=' +
        'a'.repeat(22) +
        '\n',
    );
    expect(text()).not.toContain(standard.phoneNumber);
    expect(titleOf).toHaveBeenCalledWith('expo-1');
    expect(publish).toHaveBeenCalledWith({
      eventId: 'e1',
      expoId: 'expo-1',
      participationType: 'STANDARD',
      id: 42,
    });
    expect(await redis.get('sms:event:e1')).toBe('done-v2');
  });

  it('5명은 대표자를 먼저, 동행자는 이벤트 순서대로 이름/순번을 붙인다', async () => {
    const ids = [42, 45, 43, 44, 46];
    fetchSpy.mockResolvedValue(
      Response.json(
        ids.map((id) => ({ participantId: id, name: '가'.repeat(10) })),
      ),
    );
    await service.handle({
      ...standard,
      id: 99,
      representativeId: 42,
      participants: [45, 43, 42, 44, 46].map((id) => ({
        id,
        code: 'b'.repeat(22),
      })),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(text().match(/id=\d+/g)).toEqual(ids.map((id) => 'id=' + id));
    expect(text()).toContain('가'.repeat(10) + '(대표자):');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://user.test/internal/standard-participants/names',
      expect.objectContaining({
        body: JSON.stringify({ expoId: 'expo-1', participantIds: ids }),
      }),
    );
  });

  it('새 동행자만 있는 목록에 대표자를 추가하지 않고 순번 fallback으로 보낸다', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await service.handle({
      ...standard,
      participants: [
        { id: 45, code: 'a'.repeat(22) },
        { id: 43, code: 'b'.repeat(22) },
      ],
    });
    expect(text()).toContain('동행자 1:');
    expect(text()).toContain('동행자 2:');
    expect(text()).not.toContain('대표자');
    expect(text()).not.toContain('id=42');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it('이름 조회 실패는 대표자 라벨로 대체하고 발송을 계속한다', async () => {
    fetchSpy.mockRejectedValue(new Error('private name/code/link'));
    await service.handle({
      ...standard,
      participants: [
        { id: 42, code: 'a'.repeat(22) },
        { id: 43, code: 'b'.repeat(22) },
      ],
    });
    expect(text()).toContain('대표자:');
    expect(send).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...standard, participants: undefined },
    { ...standard, participants: [{ id: 42 }] },
  ])(
    '구버전 STANDARD 이벤트는 성공 기록 없이 재시도 대상으로 실패한다',
    async (event) => {
      await expect(service.handle(event)).rejects.toBeInstanceOf(QrLinkError);
      expect(send).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(await redis.get('sms:event:e1')).toBeNull();
    },
  );

  it('잘못된 템플릿은 발송/발행 없이 실패하고 선점을 해제한다', async () => {
    config.sms.qrUrlTemplate =
      'https://expo.test/wrong?expoId={expoId}&type={participationType}&id={id}&code={code}';
    await expect(service.handle(standard)).rejects.toBeInstanceOf(QrLinkError);
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await redis.get('sms:event:e1')).toBeNull();
  });

  it('한 통의 LMS 상한을 넘으면 분할하거나 성공 처리하지 않는다', async () => {
    titleOf.mockResolvedValue('가'.repeat(1000));
    await expect(service.handle(standard)).rejects.toThrow('single LMS');
    expect(send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await redis.get('sms:event:e1')).toBeNull();
  });

  it('TRAINEE는 기존 전화번호 QR 형식으로 보내고 이름 조회/완료 발행을 하지 않는다', async () => {
    await service.handle({
      ...standard,
      participationType: 'TRAINEE',
      participants: undefined,
    });
    expect(text()).toContain('type=TRAINEE&id=42&phoneNumber=01012345678');
    expect(text()).not.toContain('code=');
    expect(send.mock.calls[0]?.[0][0]?.from).toBe(config.sms.fromTraineeNumber);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('SMS 명시적 거부 후 재전달은 다시 보내며 성공 전에는 완료를 기록하지 않는다', async () => {
    send.mockResolvedValueOnce({
      failedMessageList: [{ to: standard.phoneNumber }],
    });
    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      SmsDeliveryRejectedError,
    );
    expect(publish).not.toHaveBeenCalled();
    expect(await redis.get('sms:event:e1')).toBeNull();
    await service.handle(standard);
    expect(send).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('접수 후 응답 유실은 UNKNOWN으로 남기고 재전달돼도 문자·완료 발행을 하지 않는다', async () => {
    send.mockRejectedValue(new Error('socket hang up after accept'));
    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      SmsDeliveryUnknownError,
    );
    expect(await redis.get('sms:event:e1')).toBe('unknown');
    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      SmsDeliveryUnknownError,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('SENDING 기록만 남고 프로세스가 죽은 이벤트도 재시작 후 다시 보내지 않는다', async () => {
    await redis.set('sms:event:e1', 'sending');
    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      SmsDeliveryUnknownError,
    );
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('발행 실패 후에는 문자를 다시 보내지 않고 DLQ 상한을 넘어 발행만 재시도한다', async () => {
    publish.mockRejectedValue(new Error('broker down'));
    for (let i = 0; i < config.sms.eventMaxAttempts + 2; i += 1) {
      await expect(service.handle(standard)).rejects.toBeInstanceOf(
        SentEventPublishError,
      );
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await redis.get('sms:event:e1')).toBe('done-v2');
    publish.mockResolvedValue(undefined);
    await service.handle(standard);
    expect(await redis.get('sms:event-published:e1')).toBe('1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('반복 eventId는 이름 조회/문자/완료 발행을 반복하지 않는다', async () => {
    await service.handle(standard);
    await service.handle(standard);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('legacy done은 구버전 이벤트에도 문자와 완료 발행을 하지 않는다', async () => {
    await redis.set('sms:event:e1', 'done');
    await service.handle({ ...standard, participants: undefined });
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('done-v2 구버전 이벤트는 이미 보낸 문자 없이 완료 발행만 복구한다', async () => {
    await redis.set('sms:event:e1', 'done-v2');
    await service.handle({ ...standard, participants: undefined });
    expect(send).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('다른 인스턴스가 처리 중이면 재전달을 기다린다', async () => {
    await redis.set('sms:event:e1', 'processing');
    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      EventInProgressError,
    );
    expect(send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('발행 여부 조회 장애에도 완료 이벤트 발행은 시도한다', async () => {
    jest.spyOn(redis, 'exists').mockRejectedValue(new Error('redis down'));
    await service.handle(standard);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('발행 표시 저장 장애는 이미 보낸 문자를 실패 처리하지 않는다', async () => {
    jest
      .spyOn(store, 'markPublished')
      .mockRejectedValue(new Error('redis down'));
    await expect(service.handle(standard)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
