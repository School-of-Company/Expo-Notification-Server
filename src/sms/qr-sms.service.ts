import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ExpoNameProvider } from '../common/expo-name.provider';
import { kakaoOptionsFor } from './kakao-message';
import { KakaoSenderProvider } from './kakao-sender.provider';
import { ParticipantNamesProvider } from './participant-names.provider';
import { buildQrPageLinks } from './qr-page-links';
import { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import {
  QrLinkError,
  SentEventPublishError,
  SmsDeliveryRejectedError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { SmsEventGuard } from './sms-event.guard';
import { renderQrSms } from './sms-message.templates';
import { SmsSenderProvider } from './sms-sender.provider';

@Injectable()
export class QrSmsService {
  private readonly logger = new Logger(QrSmsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly guard: SmsEventGuard,
    private readonly dedupe: SmsEventDedupeStore,
    private readonly names: ParticipantNamesProvider,
    private readonly sender: SmsSenderProvider,
    private readonly kakao: KakaoSenderProvider,
    private readonly sentPublisher: QrSmsSentPublisher,
    private readonly expoNames: ExpoNameProvider,
  ) {}

  async handle(event: ParticipantRegisteredEvent): Promise<void> {
    const standard = event.participationType === 'STANDARD';
    const template = standard
      ? this.config.sms.qrUrlTemplate
      : this.config.sms.traineeQrUrlTemplate;
    if (!template?.trim()) {
      this.logger.warn(
        `QR 문자 템플릿 미설정으로 미발송: eventId=${event.eventId}`,
      );
      return;
    }

    const result = await this.guard.once(event.eventId, async (beginSend) => {
      const links = buildQrPageLinks(template, event);
      const names = standard
        ? await this.names.findNames({
            expoId: event.expoId,
            participantIds: links.map(({ id }) => id),
          })
        : new Map<number, string>();
      let companionNumber = 0;
      const { text, variables } = renderQrSms({
        expoName: await this.expoNames.titleOf(event.expoId),
        links: links.map(({ id, url }) => {
          const representative = id === (event.representativeId ?? event.id);
          const name = names.get(id);
          let label = '연수자';
          if (standard) {
            if (representative) {
              label = name ? `${name}(대표자)` : '대표자';
            } else {
              companionNumber += 1;
              label = name ?? `동행자 ${companionNumber}`;
            }
          }
          return { label, url };
        }),
        contactNumber: standard
          ? this.config.sms.contactStandardNumber
          : this.config.sms.contactTraineeNumber,
      });
      if (Buffer.byteLength(text, 'utf8') > 2_000) {
        throw new QrLinkError('QR SMS exceeds single LMS byte limit');
      }
      // 알림톡 본문은 1,000자까지다. 동행자가 많아 넘으면 카톡은 빼고 문자로만 보낸다.
      const kakaoOptions =
        Array.from(text).length <= 1_000
          ? kakaoOptionsFor(
              this.config,
              this.config.kakao?.auto.qrRegistered,
              variables,
            )
          : undefined;
      const message = {
        to: event.phoneNumber,
        from: standard
          ? this.config.sms.fromStandardNumber
          : this.config.sms.fromTraineeNumber,
        text,
      };
      await beginSend();
      const receipt = await this.sender.deliver(event.eventId, [message]);
      if (receipt.kind === 'rejected') {
        throw new SmsDeliveryRejectedError(`qr sms rejected: ${receipt.code}`);
      }
      if (receipt.kind === 'unknown' || receipt.failedTo.length > 0) {
        throw new SmsDeliveryUnknownError('qr sms acceptance unknown');
      }
      // 문자가 접수된 뒤에만 보내고 던지지 않는다. 카톡 결과는 재전달 여부에 영향을 주지 않는다.
      if (kakaoOptions) {
        await this.kakao.send([{ ...message, kakaoOptions }], {
          eventId: event.eventId,
        });
      }
    });

    // 문자가 이미 나간 이벤트(이번에 실행했거나 이전에 끝냄)만 여기까지 온다. 문자는 다시 보내지 않고 발행만 시도한다.
    if (standard && result !== 'legacy-done') {
      await this.publishSent(event);
    }
  }

  // 문자 발송 상태(guard)와 발행 상태를 분리해, 발행이 실패해도 재전달 때 문자는 다시 보내지 않고 발행만 재시도한다.
  // 발행이 중복돼도 User가 eventId로 걸러 준다.
  private async publishSent(event: ParticipantRegisteredEvent): Promise<void> {
    // 발행 여부를 못 읽어도 발행한다 — 중복 발행은 User가 eventId로 걸러 준다.
    const published = await this.dedupe
      .isPublished(event.eventId)
      .catch(() => false);
    if (published) {
      return;
    }
    try {
      await this.sentPublisher.publish({
        eventId: event.eventId,
        expoId: event.expoId,
        participationType: event.participationType,
        id: event.representativeId ?? event.id,
      });
    } catch (error) {
      // DLQ 횟수에 세지 않는다: 문자는 이미 나갔는데 DLQ로 보내면 이 이벤트가 영영 발행되지 않는다.
      this.logger.error(
        `qr-sms.sent 발행 실패(재전달됨): eventId=${event.eventId}`,
        error instanceof Error ? error.message : undefined,
      );
      throw new SentEventPublishError('qr-sms.sent publish failed');
    }
    await this.dedupe.markPublished(event.eventId).catch((error: unknown) => {
      this.logger.warn(
        `발행 표시 실패(중복 발행은 User가 걸러 줌): eventId=${event.eventId}`,
        error instanceof Error ? error.message : undefined,
      );
    });
  }
}
