import { Injectable, Logger } from '@nestjs/common';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { EventInProgressError } from './sms-errors';

/**
 * - `executed`: 이번에 작업을 실행했다.
 * - `already-done`: 이전에 이미 끝낸 이벤트라 건너뛰었다.
 *
 * 다른 곳에서 처리 중이면 `EventInProgressError`를 던진다. 그냥 건너뛰면, 선점을 쥔 쪽이 죽었을 때
 * 오프셋만 커밋되어 이벤트가 사라진다. 던져서 선점이 풀린 뒤에 다시 받게 한다.
 */
export type GuardResult = 'executed' | 'already-done';

@Injectable()
export class SmsEventGuard {
  private readonly logger = new Logger(SmsEventGuard.name);

  constructor(private readonly dedupe: SmsEventDedupeStore) {}

  async once(eventId: string, work: () => Promise<void>): Promise<GuardResult> {
    const claim = await this.dedupe.claim(eventId);
    if (claim === 'done') {
      this.logger.log(`이미 처리한 이벤트라 무시: eventId=${eventId}`);
      return 'already-done';
    }
    if (claim === 'in-progress') {
      throw new EventInProgressError(`event ${eventId} is being processed`);
    }

    try {
      await work();
    } catch (error) {
      await this.dedupe.release(eventId).catch((releaseError: unknown) => {
        this.logger.error(
          `이벤트 선점 해제 실패: eventId=${eventId}`,
          releaseError instanceof Error ? releaseError.message : undefined,
        );
      });
      throw error;
    }
    await this.markDone(eventId);
    return 'executed';
  }

  // 문자는 이미 나갔으므로 완료 표시가 실패해도 선점을 풀거나 던지지 않는다 (재전달되면 문자가 중복 발송된다).
  private async markDone(eventId: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.dedupe.complete(eventId);
        return;
      } catch (error) {
        if (attempt === 3) {
          this.logger.error(
            `완료 표시 실패 — 선점이 만료되면 재전달 시 문자가 중복될 수 있다: eventId=${eventId}`,
            error instanceof Error ? error.message : undefined,
          );
        }
      }
    }
  }

  async recordFailure(eventId: string): Promise<number> {
    return this.dedupe.increaseFailureCount(eventId);
  }

  async clearFailures(eventId: string): Promise<void> {
    await this.dedupe.clearFailureCount(eventId);
  }
}
