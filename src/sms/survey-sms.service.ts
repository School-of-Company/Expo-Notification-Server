import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { EntryRecordedEvent } from './participant-event.schema';
import { SmsEventGuard } from './sms-event.guard';
import { renderSurveySms } from './sms-message.templates';
import { SmsSenderProvider } from './sms-sender.provider';

@Injectable()
export class SurveySmsService {
  private readonly logger = new Logger(SurveySmsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly guard: SmsEventGuard,
    private readonly sender: SmsSenderProvider,
  ) {}

  async handle(event: EntryRecordedEvent): Promise<void> {
    if (event.participationType !== 'STANDARD') {
      return;
    }
    const template = this.config.sms.surveyUrlTemplate;
    if (!template) {
      this.logger.warn(
        `sms.surveyUrlTemplate 미설정 — 설문 문자 생략: eventId=${event.eventId}`,
      );
      return;
    }

    await this.guard.once(event.eventId, async () => {
      const { failedTo } = await this.sender.send([
        {
          to: event.phoneNumber,
          from: this.config.sms.fromStandardNumber,
          text: renderSurveySms({
            expoName: this.config.sms.expoName,
            surveyUrl: template.replaceAll(
              '{expoId}',
              encodeURIComponent(event.expoId),
            ),
          }),
        },
      ]);
      if (failedTo.length > 0) {
        throw new Error('survey sms delivery failed');
      }
    });
  }
}
