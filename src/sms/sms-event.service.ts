import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { maskPhone } from '../common/mask-phone';
import { SmsEvent } from './sms-event.schema';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { renderSms } from './sms-message.templates';
import { SmsSenderProvider } from './sms-sender.provider';

@Injectable()
export class SmsEventService {
  private readonly logger = new Logger(SmsEventService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dedupe: SmsEventDedupeStore,
    private readonly sender: SmsSenderProvider,
  ) {}

  async recordFailure(eventId: string): Promise<number> {
    return this.dedupe.increaseFailureCount(eventId);
  }

  async handle(event: SmsEvent): Promise<void> {
    if (!(await this.dedupe.claim(event.eventId))) {
      this.logger.log(`이미 처리한 이벤트라 무시: eventId=${event.eventId}`);
      return;
    }

    try {
      const { to, senderType, text } = renderSms(event);
      const from =
        senderType === 'TRAINEE'
          ? this.config.sms.fromTraineeNumber
          : this.config.sms.fromStandardNumber;

      const { total, failedTo } = await this.sender.send(
        to.map((recipient) => ({ to: recipient, from, text })),
      );

      if (failedTo.length === total) {
        throw new Error(`sms delivery failed for all ${total} recipients`);
      }
      await this.dedupe.complete(event.eventId);
      if (failedTo.length > 0) {
        this.logger.warn(
          `일부 수신자 발송 실패: eventId=${event.eventId}, failed=${failedTo.length}/${total}, to=${failedTo.map(maskPhone).join(',')}`,
        );
      }
    } catch (error) {
      await this.dedupe
        .release(event.eventId)
        .catch((releaseError: unknown) => {
          this.logger.error(
            `이벤트 선점 해제 실패: eventId=${event.eventId}`,
            releaseError instanceof Error ? releaseError.message : undefined,
          );
        });
      throw error;
    }
  }
}
