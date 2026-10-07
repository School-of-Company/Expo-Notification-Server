import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { AttentionClientProvider } from './attention-client.provider';
import { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SentEventPublishError } from './sms-errors';
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
    private readonly attention: AttentionClientProvider,
    private readonly sender: SmsSenderProvider,
    private readonly sentPublisher: QrSmsSentPublisher,
  ) {}

  async handle(event: ParticipantRegisteredEvent): Promise<void> {
    const standard = event.participationType === 'STANDARD';

    await this.guard.once(event.eventId, async () => {
      const qrUrl = await this.attention.createQrImage({
        participationType: event.participationType,
        id: event.id,
        phoneNumber: event.phoneNumber,
      });
      const { failedTo } = await this.sender.send([
        {
          to: event.phoneNumber,
          from: standard
            ? this.config.sms.fromStandardNumber
            : this.config.sms.fromTraineeNumber,
          text: renderQrSms({
            expoName: this.config.sms.expoName,
            qrUrl,
            contactNumber: standard
              ? this.config.sms.contactStandardNumber
              : this.config.sms.contactTraineeNumber,
          }),
        },
      ]);
      if (failedTo.length > 0) {
        throw new Error('qr sms delivery failed');
      }
    });

    // 문자가 이미 나간 이벤트(이번에 실행했거나 이전에 끝냄)만 여기까지 온다. 문자는 다시 보내지 않고 발행만 시도한다.
    if (standard) {
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
        id: event.id,
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
