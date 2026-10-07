import { Module } from '@nestjs/common';
import { SolapiMessageService } from 'solapi';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { AttentionClientProvider } from './attention-client.provider';
import { EntryRecordedConsumer } from './entry-recorded.consumer';
import { ParticipantRegisteredConsumer } from './participant-registered.consumer';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { QrSmsService } from './qr-sms.service';
import { SmsAuthService } from './sms-auth.service';
import { SmsAuthStore } from './sms-auth.store';
import { SmsEventConsumer } from './sms-event.consumer';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsEventService } from './sms-event.service';
import { SmsSenderProvider } from './sms-sender.provider';
import { SOLAPI_CLIENT } from './sms.constants';
import { SmsController } from './sms.controller';
import { SurveySmsService } from './survey-sms.service';

@Module({
  controllers: [SmsController],
  providers: [
    {
      provide: SOLAPI_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SolapiMessageService(config.sms.apiKey, config.sms.apiSecret),
    },
    SmsSenderProvider,
    SmsAuthStore,
    SmsEventDedupeStore,
    SmsAuthService,
    SmsEventService,
    SmsEventGuard,
    AttentionClientProvider,
    QrSmsSentPublisher,
    QrSmsService,
    SurveySmsService,
    SmsEventConsumer,
    ParticipantRegisteredConsumer,
    EntryRecordedConsumer,
  ],
})
export class SmsModule {}
