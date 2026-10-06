import { Module } from '@nestjs/common';
import { SolapiMessageService } from 'solapi';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { SmsAuthService } from './sms-auth.service';
import { SmsAuthStore } from './sms-auth.store';
import { SmsEventConsumer } from './sms-event.consumer';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventService } from './sms-event.service';
import { SmsSenderProvider } from './sms-sender.provider';
import { SOLAPI_CLIENT } from './sms.constants';
import { SmsController } from './sms.controller';

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
    SmsEventConsumer,
  ],
})
export class SmsModule {}
