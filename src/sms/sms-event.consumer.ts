import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Consumer, Kafka, KafkaMessage, Producer } from 'kafkajs';
import { parseKafkaJson } from '../common/kafka-json';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { SmsEvent, smsEventSchema } from './sms-event.schema';
import { SmsEventService } from './sms-event.service';

@Injectable()
export class SmsEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsEventConsumer.name);
  private readonly consumer: Consumer;
  private readonly producer: Producer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly smsEventService: SmsEventService,
  ) {
    this.consumer = kafka.consumer({ groupId: config.kafka.smsGroupId });
    this.producer = kafka.producer();
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.kafka.topics.smsRequested,
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const parsed = parseKafkaJson(message, smsEventSchema);
        if (!parsed.ok) {
          this.logger.warn(`잘못된 SMS 이벤트 무시: ${parsed.reason}`);
          return;
        }
        await this.process(parsed.value, message);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  private async process(event: SmsEvent, message: KafkaMessage): Promise<void> {
    try {
      await this.smsEventService.handle(event);
    } catch (error) {
      const attempts = await this.smsEventService.recordFailure(event.eventId);
      if (attempts < this.config.sms.eventMaxAttempts) {
        throw error;
      }
      // 재시도 상한을 넘기면 파티션이 막히지 않게 원본을 DLQ에 보관하고 넘어간다.
      await this.producer.send({
        topic: this.config.kafka.topics.smsDeadLetter,
        messages: [{ key: message.key, value: message.value }],
      });
      this.logger.error(
        `SMS 이벤트를 DLQ로 이동: eventId=${event.eventId}, attempts=${attempts}`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}
