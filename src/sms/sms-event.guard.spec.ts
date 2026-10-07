import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { EventInProgressError } from './sms-errors';
import { SmsEventGuard } from './sms-event.guard';

describe('SmsEventGuard', () => {
  let dedupe: {
    claim: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
    increaseFailureCount: jest.Mock;
    clearFailureCount: jest.Mock;
  };
  let guard: SmsEventGuard;

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue('claimed'),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      increaseFailureCount: jest.fn().mockResolvedValue(2),
      clearFailureCount: jest.fn(),
    };
    guard = new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore);
  });

  it('선점에 성공하면 작업 후 완료 마커로 승격하고 executed를 돌려준다', async () => {
    const work = jest.fn();

    await expect(guard.once('e1', work)).resolves.toBe('executed');
    expect(work).toHaveBeenCalled();
    expect(dedupe.complete).toHaveBeenCalledWith('e1');
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('이미 끝낸 이벤트면 작업을 건너뛰고 already-done을 돌려준다', async () => {
    dedupe.claim.mockResolvedValue('done');
    const work = jest.fn();

    await expect(guard.once('e1', work)).resolves.toBe('already-done');
    expect(work).not.toHaveBeenCalled();
  });

  it('다른 곳에서 처리 중이면 조용히 버리지 않고 EventInProgressError를 던진다 (선점이 풀린 뒤 다시 받는다)', async () => {
    dedupe.claim.mockResolvedValue('in-progress');
    const work = jest.fn();

    await expect(guard.once('e1', work)).rejects.toBeInstanceOf(
      EventInProgressError,
    );
    expect(work).not.toHaveBeenCalled();
    expect(dedupe.complete).not.toHaveBeenCalled();
    expect(dedupe.release).not.toHaveBeenCalled();
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

  it('문자 발송 뒤 완료 표시가 실패해도 선점을 풀거나 던지지 않는다 (재전달로 문자가 중복되지 않게)', async () => {
    dedupe.complete.mockRejectedValue(new Error('redis blip'));

    await expect(guard.once('e1', jest.fn())).resolves.toBe('executed');
    expect(dedupe.complete).toHaveBeenCalledTimes(3);
    expect(dedupe.release).not.toHaveBeenCalled();
  });

  it('완료 표시는 일시적인 실패 후 재시도로 성공한다', async () => {
    dedupe.complete
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValueOnce(undefined);

    await expect(guard.once('e1', jest.fn())).resolves.toBe('executed');
    expect(dedupe.complete).toHaveBeenCalledTimes(2);
  });

  it('recordFailure는 실패 횟수를, clearFailures는 카운터 삭제를 위임한다', async () => {
    await expect(guard.recordFailure('e1')).resolves.toBe(2);
    await guard.clearFailures('e1');

    expect(dedupe.increaseFailureCount).toHaveBeenCalledWith('e1');
    expect(dedupe.clearFailureCount).toHaveBeenCalledWith('e1');
  });
});
