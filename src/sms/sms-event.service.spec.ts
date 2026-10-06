import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { SmsEvent } from './sms-event.schema';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
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
  };
  let sender: { send: jest.Mock };
  let service: SmsEventService;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue(true),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      increaseFailureCount: jest.fn().mockResolvedValue(1),
    };
    sender = { send: jest.fn().mockResolvedValue({ total: 1, failedTo: [] }) };
    service = new SmsEventService(
      config,
      dedupe as unknown as SmsEventDedupeStore,
      sender as unknown as SmsSenderProvider,
    );
  });

  it('이벤트를 문자로 렌더링해 일반 참가자 발신번호로 발송한다', async () => {
    await service.handle(drawResult);

    expect(sender.send).toHaveBeenCalledWith([
      expect.objectContaining({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: expect.stringContaining('3번!') as string,
      }),
    ]);
  });

  it('TRAINEE 이벤트는 연수생 발신번호를 쓰고 수신자마다 한 건씩 보낸다', async () => {
    sender.send.mockResolvedValue({ total: 2, failedTo: [] });

    await service.handle(custom);

    expect(sender.send).toHaveBeenCalledWith([
      { to: '01011112222', from: config.sms.fromTraineeNumber, text: '공지' },
      { to: '01033334444', from: config.sms.fromTraineeNumber, text: '공지' },
    ]);
  });

  it('발송에 성공하면 claim을 완료 마커로 승격한다', async () => {
    await service.handle(drawResult);

    expect(dedupe.complete).toHaveBeenCalledWith('e1');
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('claim 해제가 실패해도 원래 에러를 그대로 던진다', async () => {
    sender.send.mockRejectedValue(new Error('gateway down'));
    dedupe.release.mockRejectedValue(new Error('redis down'));

    await expect(service.handle(drawResult)).rejects.toThrow('gateway down');
  });

  it('recordFailure는 이벤트별 실패 횟수를 돌려준다', async () => {
    dedupe.increaseFailureCount.mockResolvedValue(4);

    await expect(service.recordFailure('e1')).resolves.toBe(4);
    expect(dedupe.increaseFailureCount).toHaveBeenCalledWith('e1');
  });

  it('이미 처리한 eventId는 발송하지 않는다', async () => {
    dedupe.claim.mockResolvedValue(false);

    await service.handle(drawResult);

    expect(sender.send).not.toHaveBeenCalled();
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('전부 실패하면 claim을 풀고 던져서 재시도되게 한다', async () => {
    sender.send.mockResolvedValue({ total: 1, failedTo: ['01012345678'] });

    await expect(service.handle(drawResult)).rejects.toThrow(
      'failed for all 1',
    );
    expect(dedupe.release).toHaveBeenCalledWith('e1');
  });

  it('발송 호출이 던지면 claim을 풀고 그대로 전파한다', async () => {
    sender.send.mockRejectedValue(new Error('gateway down'));

    await expect(service.handle(drawResult)).rejects.toThrow('gateway down');
    expect(dedupe.release).toHaveBeenCalledWith('e1');
  });

  it('일부만 실패하면 던지지 않고 claim도 유지한다 (성공한 수신자 중복 발송 방지)', async () => {
    sender.send.mockResolvedValue({ total: 2, failedTo: ['01033334444'] });

    await expect(service.handle(custom)).resolves.toBeUndefined();
    expect(dedupe.release).not.toHaveBeenCalled();
    expect(dedupe.complete).toHaveBeenCalledWith('e2');
  });
});
