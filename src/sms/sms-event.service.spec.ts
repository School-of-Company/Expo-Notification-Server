import { createAppConfig } from '../../test/fixtures/app-config.fixture';
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
    service = new SmsEventService(
      config,
      new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore),
      sender as unknown as SmsSenderProvider,
    );
  });

  it('이벤트를 문자로 렌더링해 일반 참가자 발신번호로 발송한다', async () => {
    await service.handle(drawResult);

    expect(sender.deliver).toHaveBeenCalledWith('e1', [
      expect.objectContaining({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: expect.stringContaining('3번!') as string,
      }),
    ]);
  });

  it('TRAINEE 이벤트는 연수생 발신번호를 쓰고 수신자마다 한 건씩 보낸다', async () => {
    await service.handle(custom);

    expect(sender.deliver).toHaveBeenCalledWith('e2', [
      { to: '01011112222', from: config.sms.fromTraineeNumber, text: '공지' },
      { to: '01033334444', from: config.sms.fromTraineeNumber, text: '공지' },
    ]);
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
