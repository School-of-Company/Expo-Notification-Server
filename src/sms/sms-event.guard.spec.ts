import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';

describe('SmsEventGuard', () => {
  let dedupe: {
    claim: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
    increaseFailureCount: jest.Mock;
  };
  let guard: SmsEventGuard;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue(true),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      increaseFailureCount: jest.fn().mockResolvedValue(2),
    };
    guard = new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore);
  });

  it('선점에 성공하면 작업 후 완료 마커로 승격하고 done을 돌려준다', async () => {
    const work = jest.fn();

    await expect(guard.once('e1', work)).resolves.toBe('done');
    expect(work).toHaveBeenCalled();
    expect(dedupe.complete).toHaveBeenCalledWith('e1');
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('이미 처리했거나 처리 중이면 작업을 건너뛰고 duplicate를 돌려준다', async () => {
    dedupe.claim.mockResolvedValue(false);
    const work = jest.fn();

    await expect(guard.once('e1', work)).resolves.toBe('duplicate');
    expect(work).not.toHaveBeenCalled();
  });

  it('작업이 실패하면 선점을 풀고 원래 에러를 던진다', async () => {
    await expect(
      guard.once('e1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(dedupe.release).toHaveBeenCalledWith('e1');
    expect(dedupe.complete).not.toHaveBeenCalled();
  });

  it('선점 해제가 실패해도 원래 에러를 던진다', async () => {
    dedupe.release.mockRejectedValue(new Error('redis down'));

    await expect(
      guard.once('e1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('recordFailure는 이벤트별 실패 횟수를 돌려준다', async () => {
    await expect(guard.recordFailure('e1')).resolves.toBe(2);
    expect(dedupe.increaseFailureCount).toHaveBeenCalledWith('e1');
  });
});
