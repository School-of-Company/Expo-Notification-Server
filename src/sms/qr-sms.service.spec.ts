import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AttentionClientProvider } from './attention-client.provider';
import { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrSmsService } from './qr-sms.service';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsSenderProvider } from './sms-sender.provider';
import { UserClientProvider } from './user-client.provider';

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
  let dedupe: { claim: jest.Mock; complete: jest.Mock; release: jest.Mock };
  let attention: { createQrImage: jest.Mock };
  let sender: { send: jest.Mock };
  let user: { recordSmsTry: jest.Mock };
  let service: QrSmsService;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue(true),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    attention = {
      createQrImage: jest.fn().mockResolvedValue('https://s3.example/qr.jpg'),
    };
    sender = { send: jest.fn().mockResolvedValue({ total: 1, failedTo: [] }) };
    user = { recordSmsTry: jest.fn() };
    service = new QrSmsService(
      config,
      new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore),
      attention as unknown as AttentionClientProvider,
      sender as unknown as SmsSenderProvider,
      user as unknown as UserClientProvider,
    );
  });

  it('일반 참가자: QR URL을 받아 일반 발신번호/문의번호로 문자를 보내고 sms-try를 호출한다', async () => {
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
    expect(user.recordSmsTry).toHaveBeenCalledWith({
      expoId: 'expo-1',
      participationType: 'STANDARD',
      phoneNumber: '01012345678',
    });
    expect(dedupe.complete).toHaveBeenCalledWith('e1');
  });

  it('연수자: 연수 발신번호/문의번호를 쓰고 sms-try는 호출하지 않는다', async () => {
    await service.handle(trainee);

    const [[message]] = sender.send.mock.calls[0] as [
      [{ from: string; text: string }],
    ];
    expect(message.from).toBe(config.sms.fromTraineeNumber);
    expect(message.text).toContain('062-380-4587');
    expect(user.recordSmsTry).not.toHaveBeenCalled();
  });

  it('이미 처리한 eventId는 QR 생성도 문자도 sms-try도 하지 않는다', async () => {
    dedupe.claim.mockResolvedValue(false);

    await service.handle(standard);

    expect(attention.createQrImage).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(user.recordSmsTry).not.toHaveBeenCalled();
  });

  it('QR 생성이 실패하면 문자를 보내지 않고 선점을 풀고 던진다 (재전달)', async () => {
    attention.createQrImage.mockRejectedValue(
      new Error('attention responded 503'),
    );

    await expect(service.handle(standard)).rejects.toThrow(
      'attention responded 503',
    );
    expect(sender.send).not.toHaveBeenCalled();
    expect(dedupe.release).toHaveBeenCalledWith('e1');
    expect(user.recordSmsTry).not.toHaveBeenCalled();
  });

  it('문자 발송이 실패하면 sms-try를 호출하지 않고 던진다', async () => {
    sender.send.mockResolvedValue({ total: 1, failedTo: ['01012345678'] });

    await expect(service.handle(standard)).rejects.toThrow(
      'qr sms delivery failed',
    );
    expect(user.recordSmsTry).not.toHaveBeenCalled();
  });

  it('sms-try가 실패해도 던지지 않는다 (재시도하면 발송 횟수가 중복 증가)', async () => {
    user.recordSmsTry.mockRejectedValue(new Error('user responded 500'));

    await expect(service.handle(standard)).resolves.toBeUndefined();
    expect(user.recordSmsTry).toHaveBeenCalledTimes(1);
    expect(dedupe.release).not.toHaveBeenCalled();
  });
});
