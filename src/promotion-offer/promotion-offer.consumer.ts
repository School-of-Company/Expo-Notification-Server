import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Kafka } from 'kafkajs';
import type { Consumer } from 'kafkajs';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { parseKafkaJson } from '../common/kafka-json';
import { promotionOfferEventSchema } from './promotion-offer.schema';
import { PromotionOfferService } from './promotion-offer.service';

@Injectable()
export class PromotionOfferConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PromotionOfferConsumer.name);
  private consumer?: Consumer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    private readonly service: PromotionOfferService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.config.promotionOffer;
    if (!config?.enabled) return;
    const consumer = this.kafka.consumer({ groupId: config.groupId });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topic: config.topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message, topic, partition }) => {
        const parsed = parseKafkaJson(message, promotionOfferEventSchema);
        if (!parsed.ok) {
          this.logger.error({
            message: '참여 제안 이벤트 계약 오류',
            topic,
            partition,
            offset: message.offset,
          });
          return;
        }
        await this.service.handle(parsed.value);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
