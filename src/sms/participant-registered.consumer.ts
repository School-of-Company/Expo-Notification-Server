import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import {
  ParticipantRegisteredEvent,
  participantRegisteredSchema,
} from './participant-event.schema';
import { QrSmsService } from './qr-sms.service';
import { SmsEventGuard } from './sms-event.guard';
import { SmsKafkaConsumer } from './sms-kafka.consumer';

@Injectable()
export class ParticipantRegisteredConsumer extends SmsKafkaConsumer<ParticipantRegisteredEvent> {
  protected readonly logger = new Logger(ParticipantRegisteredConsumer.name);
  protected readonly schema = participantRegisteredSchema;
  protected readonly topic: string;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) config: AppConfig,
    guard: SmsEventGuard,
    private readonly qrSmsService: QrSmsService,
  ) {
    super(
      kafka,
      `${config.kafka.smsGroupId}.participant-registered`,
      config,
      guard,
    );
    this.topic = config.kafka.topics.participantRegistered;
  }

  protected async handle(event: ParticipantRegisteredEvent): Promise<void> {
    await this.qrSmsService.handle(event);
  }
}
