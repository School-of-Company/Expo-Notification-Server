import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { maskPhone } from '../common/mask-phone';
import {
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { kakaoOptionsFor } from './kakao-message';
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
    await this.guard.once(event.eventId, async (beginSend) => {
      const { to, senderType, text, variables } = renderSms(event);
      // CUSTOM은 승인 템플릿이 없는 자유 문구라 문자로만 보낸다.
      const kakaoOptions =
        variables &&
        kakaoOptionsFor(
          this.config,
          this.config.kakao?.auto.drawResult,
          variables,
        );
      const from =
        senderType === 'TRAINEE'
          ? this.config.sms.fromTraineeNumber
          : this.config.sms.fromStandardNumber;

      await beginSend();
      const receipt = await this.sender.deliver(
        event.eventId,
        to.map((recipient) => ({
          to: recipient,
          from,
          text,
          ...(kakaoOptions && { kakaoOptions }),
        })),
      );

      if (receipt.kind === 'rejected') {
        throw new SmsDeliveryRejectedError(
          `sms rejected for all ${to.length} recipients: ${receipt.code}`,
        );
      }
      if (receipt.kind === 'unknown') {
        throw new SmsDeliveryUnknownError('sms acceptance unknown');
      }
      // 일부 실패는 접수된 수신자가 있어 재시도하면 그들에게 중복된다. 기록만 남기고 완료한다.
      const { failedTo } = receipt;
      if (failedTo.length > 0) {
        this.logger.warn(
          `일부 수신자 발송 실패: eventId=${event.eventId}, failed=${failedTo.length}/${to.length}, to=${failedTo.map(maskPhone).join(',')}`,
        );
      }
    });
  }
}
