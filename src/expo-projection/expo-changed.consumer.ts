import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Consumer, Kafka, KafkaMessage, Partitioners, Producer } from 'kafkajs';
import { parseKafkaJson } from '../common/kafka-json';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import {
  expoChangedEventSchema,
  SUPPORTED_SCHEMA_VERSION,
} from './expo-changed.schema';
import { ExpoProjectionService } from './expo-projection.service';

/**
 * `expo.expo.changed` → Redis 프로젝션. `expoProjection.enabled`가 false면 Kafka에 붙지 않는다.
 * - 형식이 틀리거나 모르는 schemaVersion인 메시지는 재전달해도 그대로라 바로 DLQ로 옮긴다.
 * - 반영 실패(Redis 장애 등)는 던져서 재전달시키고, `maxAttempts`번 실패하면 DLQ로 옮기고 넘어간다.
 *   실패 횟수는 Redis가 아니라 메모리에 센다. 실패 원인이 Redis일 때도 셀 수 있어야 해서다.
 */
@Injectable()
export class ExpoChangedConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExpoChangedConsumer.name);
  private consumer?: Consumer;
  private producer?: Producer;
  private readonly failures = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    private readonly service: ExpoProjectionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const settings = this.config.expoProjection;
    if (!settings.enabled) return;
    const producer = this.kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
    const consumer = this.kafka.consumer({ groupId: settings.groupId });
    this.producer = producer;
    this.consumer = consumer;
    await producer.connect();
    await consumer.connect();
    // 처음 붙는 그룹은 토픽에 남은 이벤트부터 읽는다. 빠진 박람회는 Expo republish로 채운다.
    await consumer.subscribe({ topic: settings.topic, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ partition, message }) => this.consume(partition, message),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
  }

  private async consume(
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const parsed = parseKafkaJson(message, expoChangedEventSchema);
    if (!parsed.ok) {
      await this.moveToDeadLetter(message, parsed.reason);
      return;
    }
    const event = parsed.value;
    if (event.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      await this.moveToDeadLetter(
        message,
        `unsupported schemaVersion ${event.schemaVersion}`,
      );
      return;
    }

    const attemptKey = `${partition}:${message.offset}`;
    try {
      await this.service.apply(event);
      this.failures.delete(attemptKey);
    } catch (error) {
      const attempts = (this.failures.get(attemptKey) ?? 0) + 1;
      if (attempts < this.config.expoProjection.maxAttempts) {
        this.failures.set(attemptKey, attempts);
        throw error;
      }
      await this.moveToDeadLetter(
        message,
        error instanceof Error ? error.message : 'apply failed',
      );
      this.failures.delete(attemptKey);
    }
  }

  private async moveToDeadLetter(
    message: KafkaMessage,
    reason: string,
  ): Promise<void> {
    const { topic, deadLetterTopic } = this.config.expoProjection;
    await this.producer!.send({
      topic: deadLetterTopic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: { 'x-source-topic': topic, 'x-error': reason },
        },
      ],
    });
    this.logger.error(
      `박람회 변경 이벤트를 DLQ로 이동: topic=${topic}, offset=${message.offset}`,
      reason,
    );
  }
}
