import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { logLevel, Partitioners } from 'kafkajs';
import type { Admin, Producer } from 'kafkajs';
import { createAppConfig } from '../fixtures/app-config.fixture';
import { APP_CONFIG } from '../../src/config/app-config.constants';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';
import { KAFKA_CLIENT } from '../../src/kafka/kafka.constants';
import { PromotionModule } from '../../src/promotion/promotion.module';
import { PromotionService } from '../../src/promotion/promotion.service';
import { PromotionStore } from '../../src/promotion/promotion.store';
import { PromotionScheduler } from '../../src/promotion/promotion.scheduler';
import type { PromotionEvent } from '../../src/promotion/promotion.schema';
import type { LocalInfra } from './local-infra';
import { until } from './local-infra';
import { ObservedKafka } from './observed-kafka';
import { PromotionHttpFixture } from './promotion-fixture';
import { AppConfigModule } from '../../src/config/app-config.module';
import { RedisModule } from '../../src/redis/redis.module';
import { KafkaModule } from '../../src/kafka/kafka.module';

export class PromotionRuntime {
  readonly http = new PromotionHttpFixture();
  readonly redis: Redis;
  readonly kafka: ObservedKafka;
  readonly admin: Admin;
  readonly producer: Producer;
  readonly topic = `promotion20-${randomUUID()}`;
  readonly groupId = `promotion20-${randomUUID()}`;
  app?: INestApplication<Server>;
  private restoreFetch?: () => void;

  constructor(infra: LocalInfra) {
    this.redis = new Redis({
      host: '127.0.0.1',
      port: infra.redisPort,
      lazyConnect: true,
      keyPrefix: `${this.topic}:`,
    });
    this.kafka = new ObservedKafka({
      brokers: [`127.0.0.1:${infra.kafkaPort}`],
      logLevel: logLevel.NOTHING,
      retry: { initialRetryTime: 100, maxRetryTime: 1000, retries: 10 },
    });
    this.admin = this.kafka.admin();
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
  }

  async prepare(): Promise<void> {
    await this.http.start();
    const original = global.fetch;
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input, init) => {
        if (
          typeof input === 'string' &&
          input.startsWith('https://api.solapi.com/')
        ) {
          return original(
            input.replace('https://api.solapi.com', this.http.url),
            init,
          );
        }
        if (typeof input === 'string' && input.startsWith(this.http.url))
          return original(input, init);
        throw new Error(
          'unexpected external request in promotion contract test',
        );
      });
    this.restoreFetch = () => spy.mockRestore();
    await this.redis.connect();
    await this.admin.connect();
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic: this.topic, numPartitions: 1, replicationFactor: 1 }],
    });
    await this.producer.connect();
  }

  async start(): Promise<void> {
    const base = createAppConfig();
    const config = createAppConfig({
      sms: { ...base.sms, expoName: 'AI 미래교육 페스타' },
      promotion: {
        enabled: true,
        application: { baseUrl: this.http.url, internalToken: 'a'.repeat(32) },
        internalToken: 'o'.repeat(32),
        topic: this.topic,
        groupId: this.groupId,
        recoveryHold: false,
      },
    });
    const module = await Test.createTestingModule({
      imports: [AppConfigModule, RedisModule, KafkaModule, PromotionModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(REDIS_CLIENT)
      .useValue(this.redis)
      .overrideProvider(KAFKA_CLIENT)
      .useValue(this.kafka)
      .compile();
    this.app = module.createNestApplication<INestApplication<Server>>();
    await this.app.init();
  }

  async publish(event: PromotionEvent): Promise<void> {
    await this.producer.send({
      topic: this.topic,
      messages: [{ key: event.eventId, value: JSON.stringify(event) }],
    });
  }

  async committed(offset: number): Promise<void> {
    await until(async () => {
      const result = await this.admin.fetchOffsets({
        groupId: this.groupId,
        topics: [this.topic],
      });
      return Number(result[0]?.partitions[0]?.offset) >= offset;
    });
  }

  get store(): PromotionStore {
    if (!this.app) throw new Error('runtime not started');
    return this.app.get<PromotionStore>(PromotionStore);
  }
  get service(): PromotionService {
    if (!this.app) throw new Error('runtime not started');
    return this.app.get<PromotionService>(PromotionService);
  }
  async retry(id: string): Promise<void> {
    if (!this.app) throw new Error('runtime not started');
    const status = (await this.store.get(id))?.status;
    if (status === 'PENDING' || status === 'ACCEPTED')
      await this.redis.zadd(
        'promotion:{notifications}:due',
        Date.now() - 1,
        id,
      );
    await this.app.get<PromotionScheduler>(PromotionScheduler).retry();
  }

  async close(): Promise<void> {
    try {
      await this.app?.close();
      await this.producer.disconnect();
      await this.admin.disconnect();
    } finally {
      this.redis.disconnect();
      this.restoreFetch?.();
      await this.http.close();
    }
  }
}
