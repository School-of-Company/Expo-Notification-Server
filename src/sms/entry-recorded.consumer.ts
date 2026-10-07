import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import {
  EntryRecordedEvent,
  entryRecordedSchema,
} from './participant-event.schema';
import { SmsEventGuard } from './sms-event.guard';
import { SmsKafkaConsumer } from './sms-kafka.consumer';
import { SurveySmsService } from './survey-sms.service';

@Injectable()
export class EntryRecordedConsumer extends SmsKafkaConsumer<EntryRecordedEvent> {
  protected readonly logger = new Logger(EntryRecordedConsumer.name);
  protected readonly schema = entryRecordedSchema;
  protected readonly topic: string;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) config: AppConfig,
    guard: SmsEventGuard,
    private readonly surveySmsService: SurveySmsService,
  ) {
    super(kafka, `${config.kafka.smsGroupId}.entry-recorded`, config, guard);
    this.topic = config.kafka.topics.entryRecorded;
  }

  protected async handle(event: EntryRecordedEvent): Promise<void> {
    await this.surveySmsService.handle(event);
  }
}
