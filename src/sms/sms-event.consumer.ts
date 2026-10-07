import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { SmsEvent, smsEventSchema } from './sms-event.schema';
import { SmsEventGuard } from './sms-event.guard';
import { SmsEventService } from './sms-event.service';
import { SmsKafkaConsumer } from './sms-kafka.consumer';

@Injectable()
export class SmsEventConsumer extends SmsKafkaConsumer<SmsEvent> {
  protected readonly logger = new Logger(SmsEventConsumer.name);
  protected readonly schema = smsEventSchema;
  protected readonly topic: string;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) config: AppConfig,
    guard: SmsEventGuard,
    private readonly smsEventService: SmsEventService,
  ) {
    super(kafka, config.kafka.smsGroupId, config, guard);
    this.topic = config.kafka.topics.smsRequested;
  }

  protected async handle(event: SmsEvent): Promise<void> {
    await this.smsEventService.handle(event);
  }
}
