import { Injectable, Logger } from '@nestjs/common';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import {
  EventInProgressError,
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';

/**
 * - `executed`: 이번에 작업을 실행했다.
 * - `already-done`: 이전에 이미 끝낸 이벤트라 건너뛰었다.
 *
 * 다른 곳에서 처리 중이면 `EventInProgressError`를 던진다. 그냥 건너뛰면, 선점을 쥔 쪽이 죽었을 때
 * 오프셋만 커밋되어 이벤트가 사라진다. 던져서 선점이 풀린 뒤에 다시 받게 한다.
 *
 * 작업은 공급자 호출 직전에 `beginSend()`를 불러야 한다. 그 뒤의 실패는 `SmsDeliveryRejectedError`
 * (확실한 미접수)일 때만 선점을 풀고, 그 외에는 UNKNOWN으로 남기고 `SmsDeliveryUnknownError`를 던진다.
 * 이전에 결과 불명으로 남은 이벤트도 다시 보내지 않고 `SmsDeliveryUnknownError`를 던진다.
 */
export type GuardResult = 'executed' | 'already-done' | 'legacy-done';

@Injectable()
export class SmsEventGuard {
  private readonly logger = new Logger(SmsEventGuard.name);

  constructor(private readonly dedupe: SmsEventDedupeStore) {}

  async once(
    eventId: string,
    work: (beginSend: () => Promise<void>) => Promise<void>,
  ): Promise<GuardResult> {
    const claim = await this.dedupe.claim(eventId);
    switch (claim) {
      case 'done':
        this.logger.log(`이미 처리한 이벤트라 무시: eventId=${eventId}`);
        return 'already-done';
      case 'legacy-done':
        return 'legacy-done';
      case 'in-progress':
        throw new EventInProgressError(`event ${eventId} is being processed`);
      case 'unknown':
        throw new SmsDeliveryUnknownError(
          `event ${eventId} has unknown delivery result`,
        );
      case 'claimed':
        break;
      default:
        throw new TypeError(String(claim satisfies never));
    }

    let sending = false;
    try {
      await work(async () => {
        await this.dedupe.markSending(eventId);
        sending = true;
      });
    } catch (error) {
      if (sending && !(error instanceof SmsDeliveryRejectedError)) {
        await this.keepUnknown(eventId, error);
        throw error instanceof SmsDeliveryUnknownError
          ? error
          : new SmsDeliveryUnknownError(
              `event ${eventId} failed after provider call`,
            );
      }
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

  // 기록이 실패해도 SENDING이 같은 기간 남아 있어 재발송은 막힌다. UNKNOWN은 운영자가 원인을 구분하려는 표시다.
  private async keepUnknown(eventId: string, cause: unknown): Promise<void> {
    this.logger.error(
      `문자 접수 결과 불명 — 자동 재발송하지 않음: eventId=${eventId}`,
      cause instanceof Error ? cause.message : undefined,
    );
    await this.dedupe.markUnknown(eventId).catch((error: unknown) => {
      this.logger.warn(
        `UNKNOWN 표시 실패(SENDING 유지): eventId=${eventId}`,
        error instanceof Error ? error.message : undefined,
      );
    });
  }

  // 문자는 이미 나갔으므로 완료 표시가 실패해도 선점을 풀거나 던지지 않는다.
  // SENDING 표시가 완료 마커와 같은 기간 남아, 재전달돼도 결과 불명으로 보고 다시 보내지 않는다.
  private async markDone(eventId: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.dedupe.complete(eventId);
        return;
      } catch (error) {
        if (attempt === 3) {
          this.logger.error(
            `완료 표시 실패 — 재전달 시 결과 불명(UNKNOWN)으로 처리돼 재발송되지 않는다: eventId=${eventId}`,
            error instanceof Error ? error.message : undefined,
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
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
