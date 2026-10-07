import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AttentionClientProvider } from './attention-client.provider';
import { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { QrSmsService } from './qr-sms.service';
import { EventInProgressError, SentEventPublishError } from './sms-errors';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsSenderProvider } from './sms-sender.provider';

const config = createAppConfig();

const standard: ParticipantRegisteredEvent = {
  eventId: 'e1',
  expoId: 'expo-1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '01012345678',
};
const trainee: ParticipantRegisteredEvent = {
  ...standard,
  eventId: 'e2',
  participationType: 'TRAINEE',
};

describe('QrSmsService', () => {
  let dedupe: {
    claim: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
    isPublished: jest.Mock;
    markPublished: jest.Mock;
  };
  let attention: { createQrImage: jest.Mock };
  let sender: { send: jest.Mock };
  let publisher: { publish: jest.Mock };
  let service: QrSmsService;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue('claimed'),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      isPublished: jest.fn().mockResolvedValue(false),
      markPublished: jest.fn().mockResolvedValue(undefined),
    };
    attention = {
      createQrImage: jest.fn().mockResolvedValue('https://s3.example/qr.jpg'),
    };
    sender = { send: jest.fn().mockResolvedValue({ total: 1, failedTo: [] }) };
    publisher = { publish: jest.fn() };
    const store = dedupe as unknown as SmsEventDedupeStore;
    service = new QrSmsService(
      config,
      new SmsEventGuard(store),
      store,
      attention as unknown as AttentionClientProvider,
      sender as unknown as SmsSenderProvider,
      publisher as unknown as QrSmsSentPublisher,
    );
  });

  it('일반 참가자: QR URL을 받아 일반 발신번호/문의번호로 문자를 보내고 발송 완료 이벤트를 발행한다', async () => {
    await service.handle(standard);

    expect(attention.createQrImage).toHaveBeenCalledWith({
      participationType: 'STANDARD',
      id: 42,
      phoneNumber: '01012345678',
    });
    expect(sender.send).toHaveBeenCalledWith([
      {
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: '광주 박람회 현장 등록이 완료되었습니다.\n출입 QR코드 링크: https://s3.example/qr.jpg\n(문의) ☎062-380-4504',
      },
    ]);
    expect(publisher.publish).toHaveBeenCalledWith({
      eventId: 'e1',
      expoId: 'expo-1',
      participationType: 'STANDARD',
      id: 42,
    });
    expect(dedupe.markPublished).toHaveBeenCalledWith('e1');
  });

  it('발송 완료 이벤트에 전화번호를 싣지 않는다 (개인정보 최소화)', async () => {
    await service.handle(standard);

    const [event] = publisher.publish.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'expoId',
      'id',
      'participationType',
    ]);
  });

  it('연수자: 연수 발신번호/문의번호를 쓰고 이벤트는 발행하지 않는다', async () => {
    await service.handle(trainee);

    const [[message]] = sender.send.mock.calls[0] as [
      [{ from: string; text: string }],
    ];
    expect(message.from).toBe(config.sms.fromTraineeNumber);
    expect(message.text).toContain('062-380-4587');
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('QR 생성이 실패하면 문자도 이벤트도 없이 선점을 풀고 던진다 (재전달)', async () => {
    attention.createQrImage.mockRejectedValue(
      new Error('attention responded 503'),
    );

    await expect(service.handle(standard)).rejects.toThrow(
      'attention responded 503',
    );
    expect(sender.send).not.toHaveBeenCalled();
    expect(dedupe.release).toHaveBeenCalledWith('e1');
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('문자 발송이 실패하면 이벤트를 발행하지 않고 던진다', async () => {
    sender.send.mockResolvedValue({ total: 1, failedTo: ['01012345678'] });

    await expect(service.handle(standard)).rejects.toThrow(
      'qr sms delivery failed',
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('발행이 실패하면 DLQ 횟수에 세지 않는 에러로 던지고 문자 완료 마커는 유지한다 (재전달 때 문자를 다시 보내지 않기 위해)', async () => {
    publisher.publish.mockRejectedValue(new Error('broker down'));

    const error = await service.handle(standard).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SentEventPublishError);
    expect((error as SentEventPublishError).countsTowardDeadLetter).toBe(false);
    expect(dedupe.complete).toHaveBeenCalledWith('e1');
    expect(dedupe.release).not.toHaveBeenCalled();
    expect(dedupe.markPublished).not.toHaveBeenCalled();
  });

  it('재전달: 이미 문자를 보낸 이벤트는 문자 없이 발행만 다시 시도한다', async () => {
    dedupe.claim.mockResolvedValue('done');

    await service.handle(standard);

    expect(attention.createQrImage).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(dedupe.markPublished).toHaveBeenCalledWith('e1');
  });

  it('이미 발행한 이벤트는 다시 발행하지 않는다', async () => {
    dedupe.claim.mockResolvedValue('done');
    dedupe.isPublished.mockResolvedValue(true);

    await service.handle(standard);

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('다른 곳에서 처리 중이면 버리지 않고 던진다. 문자도 발행도 하지 않는다 (문자가 아직 안 나갔을 수 있음)', async () => {
    dedupe.claim.mockResolvedValue('in-progress');

    await expect(service.handle(standard)).rejects.toBeInstanceOf(
      EventInProgressError,
    );
    expect(sender.send).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('발행 여부를 읽지 못해도 발행한다 (중복 발행은 User가 걸러 줌)', async () => {
    dedupe.isPublished.mockRejectedValue(new Error('redis blip'));

    await expect(service.handle(standard)).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('발행 뒤 발행 표시가 실패해도 던지지 않는다 (재전달로 인한 중복 발행만 생김)', async () => {
    dedupe.markPublished.mockRejectedValue(new Error('redis blip'));

    await expect(service.handle(standard)).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});
