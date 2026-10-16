import {
  Logger,
  OnModuleDestroy,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Consumer, Kafka, KafkaMessage, Partitioners, Producer } from 'kafkajs';
import { ZodType } from 'zod';
import { parseKafkaJson } from '../common/kafka-json';
import { AppConfig } from '../config/app-config';
import { SmsEventGuard } from './sms-event.guard';
import { countsTowardDeadLetter, SmsDeliveryUnknownError } from './sms-errors';

/**
 * 문자 발송 이벤트 consumer 공통부.
 * - 형식이 틀린 메시지는 로그만 남기고 건너뛴다 (던지면 Kafka가 무한 재전달한다).
 * - 처리 실패는 던져서 재전달시키되, `sms.eventMaxAttempts`번 실패하면 원본을 DLQ로 옮기고 넘어간다.
 *   (발행 실패·처리 중 대기는 횟수에 세지 않는다 — sms-errors.ts)
 * - 접수 결과 불명은 재전달하지 않는다: 원본을 `x-sms-delivery: UNKNOWN` 헤더로 DLQ에 보관하고 다음 이벤트로 넘어간다.
 */
export abstract class SmsKafkaConsumer<T extends { eventId: string }>
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected abstract readonly logger: Logger;
  protected abstract readonly schema: ZodType<T>;
  protected abstract readonly topic: string;
  protected abstract handle(event: T): Promise<void>;

  private readonly consumer: Consumer;
  private readonly producer: Producer;

  protected constructor(
    kafka: Kafka,
    groupId: string,
    protected readonly config: AppConfig,
    private readonly guard: SmsEventGuard,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const parsed = parseKafkaJson(message, this.schema);
        if (!parsed.ok) {
          this.logger.warn(
            `잘못된 이벤트 무시(${this.topic}): ${parsed.reason}`,
          );
          return;
        }
        // 첫 메시지 실패로 재시작해도 latest로 건너뛰지 않도록 현재 위치(다음 위치 아님)를 저장한다.
        await this.consumer.commitOffsets([
          { topic, partition, offset: message.offset },
        ]);
        await this.process(parsed.value, message);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  private async process(event: T, message: KafkaMessage): Promise<void> {
    try {
      await this.handle(event);
    } catch (error) {
      if (error instanceof SmsDeliveryUnknownError) {
        await this.moveToDeadLetter(message, { 'x-sms-delivery': 'UNKNOWN' });
        this.logger.error(
          `접수 결과 불명 이벤트를 DLQ에 보관(자동 재발송 안 함): topic=${this.topic}, eventId=${event.eventId}`,
        );
        return;
      }
      if (!countsTowardDeadLetter(error)) {
        throw error;
      }
      const attempts = await this.guard.recordFailure(event.eventId);
      if (attempts < this.config.sms.eventMaxAttempts) {
        throw error;
      }
      await this.moveToDeadLetter(message);
      await this.guard
        .clearFailures(event.eventId)
        .catch((cleanupError: unknown) => {
          this.logger.warn({
            message: 'DLQ 전송 후 실패 카운터 정리 실패',
            eventId: event.eventId,
            error:
              cleanupError instanceof Error ? cleanupError.message : undefined,
          });
        });
      this.logger.error(
        `이벤트를 DLQ로 이동: topic=${this.topic}, eventId=${event.eventId}, attempts=${attempts}`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private async moveToDeadLetter(
    message: KafkaMessage,
    headers: Record<string, string> = {},
  ): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.topics.smsDeadLetter,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: { 'x-source-topic': this.topic, ...headers },
        },
      ],
    });
  }
}
