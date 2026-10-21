import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ExpoNameProvider } from '../common/expo-name.provider';
import { maskPhone } from '../common/mask-phone';
import {
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { kakaoOptionsFor } from './kakao-message';
import { KakaoSenderProvider } from './kakao-sender.provider';
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
    private readonly kakao: KakaoSenderProvider,
    private readonly expoNames: ExpoNameProvider,
  ) {}

  async handle(event: SmsEvent): Promise<void> {
    await this.guard.once(event.eventId, async (beginSend) => {
      const { to, senderType, text, variables } = renderSms(event, {
        // CUSTOM은 행사명을 쓰지 않아 조회하지 않는다(expoId 없이 부르면 기본 행사명만 돌려준다).
        expoName: await this.expoNames.titleOf(
          event.type === 'DRAW_RESULT' ? event.expoId : undefined,
        ),
        prizePlace: this.config.sms.drawPrizePlace,
      });
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

      const messages = to.map((recipient) => ({ to: recipient, from, text }));

      await beginSend();
      const receipt = await this.sender.deliver(event.eventId, messages);

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
      // 문자가 접수된 뒤에만 보내고 던지지 않는다. 카톡 결과는 재전달 여부에 영향을 주지 않는다.
      if (kakaoOptions) {
        await this.kakao.send(
          messages.map((message) => ({ ...message, kakaoOptions })),
          { eventId: event.eventId },
        );
      }
    });
  }
}
