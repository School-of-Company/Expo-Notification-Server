import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Kafka, Partitioners, Producer } from 'kafkajs';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { ParticipationType } from './participation-type';

export interface QrSmsSentEvent {
  eventId: string;
  expoId: string;
  participationType: ParticipationType;
  id: number;
}

/** QR 문자 발송 완료를 User 서비스에 알린다 (User가 eventId 멱등으로 문자 발송 횟수를 한 번만 올린다). */
@Injectable()
export class QrSmsSentPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly producer: Producer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async publish(event: QrSmsSentEvent): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.topics.qrSmsSent,
      messages: [{ key: event.eventId, value: JSON.stringify(event) }],
    });
  }
}
