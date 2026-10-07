import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Consumer, Kafka, KafkaMessage, Producer } from 'kafkajs';
import { ZodType } from 'zod';
import { parseKafkaJson } from '../common/kafka-json';
import { AppConfig } from '../config/app-config';
import { SmsEventGuard } from './sms-event.guard';

/**
 * 문자 발송 이벤트 consumer 공통부.
 * - 형식이 틀린 메시지는 로그만 남기고 건너뛴다 (던지면 Kafka가 무한 재전달한다).
 * - 처리 실패는 던져서 재전달시키되, `sms.eventMaxAttempts`번 실패하면 원본을 DLQ로 옮기고 넘어간다.
 */
export abstract class SmsKafkaConsumer<T extends { eventId: string }>
  implements OnModuleInit, OnModuleDestroy
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
    this.producer = kafka.producer();
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const parsed = parseKafkaJson(message, this.schema);
        if (!parsed.ok) {
          this.logger.warn(
            `잘못된 이벤트 무시(${this.topic}): ${parsed.reason}`,
          );
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

  private async process(event: T, message: KafkaMessage): Promise<void> {
    try {
      await this.handle(event);
    } catch (error) {
      const attempts = await this.guard.recordFailure(event.eventId);
      if (attempts < this.config.sms.eventMaxAttempts) {
        throw error;
      }
      await this.producer.send({
        topic: this.config.kafka.topics.smsDeadLetter,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: { 'x-source-topic': this.topic },
          },
        ],
      });
      this.logger.error(
        `이벤트를 DLQ로 이동: topic=${this.topic}, eventId=${event.eventId}, attempts=${attempts}`,
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}
