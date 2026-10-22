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

// Solapi 장문(LMS) 본문 상한.
const MAX_TEXT_BYTES = 2000;

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
    if (!this.shouldSend(event)) return;
    await this.guard.once(event.eventId, async (beginSend) => {
      const { to, senderType, text, variables } = renderSms(event, {
        // CUSTOM은 행사명을 쓰지 않아 조회하지 않는다(expoId 없이 부르면 기본 행사명만 돌려준다).
        expoName: await this.expoNames.titleOf(
          event.type === 'CUSTOM' ? undefined : event.expoId,
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

      // 장문(LMS) 상한을 넘는 본문은 다시 받아도 같아 재시도하지 않는다. 완료 처리하고 운영 확인용 로그만 남긴다.
      if (
        event.type !== 'DRAW_RESULT' &&
        event.type !== 'CUSTOM' &&
        Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
      ) {
        this.logger.error(
          `신청 결과 문자 본문이 ${MAX_TEXT_BYTES}바이트를 넘어 발송하지 않음: eventId=${event.eventId}, type=${event.type}`,
        );
        return;
      }

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

  // Application 신청 결과(#110)만 대상이다. 허용 박람회가 아니거나 오래된 이벤트는 보내지 않고 끝낸다.
  // 건너뛰어도 선점하지 않으므로 나중에 허용 목록을 넓혀 같은 이벤트가 다시 와도 막히지 않는다.
  private shouldSend(event: SmsEvent): boolean {
    if (event.type === 'DRAW_RESULT' || event.type === 'CUSTOM') return true;
    const { expoIds, maxAgeSeconds } = this.config.sms.applicationResult;
    if (expoIds && !expoIds.includes(event.expoId)) {
      this.logger.log(
        `허용되지 않은 박람회의 신청 결과 문자 건너뜀: eventId=${event.eventId}, type=${event.type}`,
      );
      return false;
    }
    if (Date.now() - Date.parse(event.occurredAt) > maxAgeSeconds * 1000) {
      this.logger.warn(
        `오래된 신청 결과 이벤트라 소급 발송하지 않음: eventId=${event.eventId}, type=${event.type}`,
      );
      return false;
    }
    return true;
  }
}
