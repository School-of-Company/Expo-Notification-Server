import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { maskPhone } from '../common/mask-phone';
import { SmsEvent } from './sms-event.schema';
import { SmsEventGuard } from './sms-event.guard';
import { renderSms } from './sms-message.templates';
import { SmsSenderProvider } from './sms-sender.provider';

@Injectable()
export class SmsEventService {
  private readonly logger = new Logger(SmsEventService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly guard: SmsEventGuard,
    private readonly sender: SmsSenderProvider,
  ) {}

  async handle(event: SmsEvent): Promise<void> {
    await this.guard.once(event.eventId, async () => {
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
      if (failedTo.length > 0) {
        this.logger.warn(
          `일부 수신자 발송 실패: eventId=${event.eventId}, failed=${failedTo.length}/${total}, to=${failedTo.map(maskPhone).join(',')}`,
        );
      }
    });
  }
}
