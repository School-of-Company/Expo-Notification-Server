import { Injectable, Logger } from '@nestjs/common';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';

export type GuardResult = 'done' | 'duplicate';

@Injectable()
export class SmsEventGuard {
  private readonly logger = new Logger(SmsEventGuard.name);

  constructor(private readonly dedupe: SmsEventDedupeStore) {}

  async once(eventId: string, work: () => Promise<void>): Promise<GuardResult> {
    if (!(await this.dedupe.claim(eventId))) {
      this.logger.log(`이미 처리한 이벤트라 무시: eventId=${eventId}`);
      return 'duplicate';
    }
    try {
      await work();
      await this.dedupe.complete(eventId);
      return 'done';
    } catch (error) {
      await this.dedupe.release(eventId).catch((releaseError: unknown) => {
        this.logger.error(
          `이벤트 선점 해제 실패: eventId=${eventId}`,
          releaseError instanceof Error ? releaseError.message : undefined,
        );
      });
      throw error;
    }
  }

  async recordFailure(eventId: string): Promise<number> {
    return this.dedupe.increaseFailureCount(eventId);
  }
}
