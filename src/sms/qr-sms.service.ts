import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../common/mask-phone';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { AttentionClientProvider } from './attention-client.provider';
import { ParticipantRegisteredEvent } from './participant-event.schema';
import { SmsEventGuard } from './sms-event.guard';
import { renderQrSms } from './sms-message.templates';
import { SmsSenderProvider } from './sms-sender.provider';
import { UserClientProvider } from './user-client.provider';

@Injectable()
export class QrSmsService {
  private readonly logger = new Logger(QrSmsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly guard: SmsEventGuard,
    private readonly attention: AttentionClientProvider,
    private readonly sender: SmsSenderProvider,
    private readonly user: UserClientProvider,
  ) {}

  async handle(event: ParticipantRegisteredEvent): Promise<void> {
    const standard = event.participationType === 'STANDARD';

    const result = await this.guard.once(event.eventId, async () => {
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

    if (result === 'done' && standard) {
      await this.recordSmsTry(event);
    }
  }

  // User의 sms-try는 eventId 멱등이 없어(Expo-User-Server#38) 재시도하면 발송 횟수가 중복 증가한다.
  // 그래서 문자 발송이 끝난 뒤 한 번만 시도하고, 실패해도 재시도하지 않는다.
  private async recordSmsTry(event: ParticipantRegisteredEvent): Promise<void> {
    try {
      await this.user.recordSmsTry({
        expoId: event.expoId,
        participationType: event.participationType,
        phoneNumber: event.phoneNumber,
      });
    } catch (error) {
      this.logger.error(
        `sms-try 호출 실패(재시도하지 않음): eventId=${event.eventId}, phone=${maskPhone(event.phoneNumber)}`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}
