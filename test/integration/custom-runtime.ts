import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { logLevel, Partitioners } from 'kafkajs';
import type { Admin, Producer } from 'kafkajs';
import type { AppConfig } from '../../src/config/app-config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../fixtures/app-config.fixture';
import { APP_CONFIG } from '../../src/config/app-config.constants';
import { KAFKA_CLIENT } from '../../src/kafka/kafka.constants';
import { SmsEventConsumer } from '../../src/sms/sms-event.consumer';
import { SmsEventService } from '../../src/sms/sms-event.service';
import { SmsEventGuard } from '../../src/sms/sms-event.guard';
import { SmsEventDedupeStore } from '../../src/sms/sms-event-dedupe.store';
import { SmsSenderProvider } from '../../src/sms/sms-sender.provider';
import type {
  OutgoingSms,
  SmsSendResult,
} from '../../src/sms/sms-sender.provider';
import { smsEventSchema } from '../../src/sms/sms-event.schema';
import type { LocalInfra } from './local-infra';
import { until } from './local-infra';
import { ObservedKafka } from './observed-kafka';

export const event = () => {
  const parsed = smsEventSchema.parse({
    eventId: randomUUID(),
    version: 1,
    type: 'CUSTOM',
    phoneNumbers: ['01000000000'],
    senderType: 'TRAINEE',
    text: '[Synthetic expo] registration complete\n* synthetic program',
  });
  if (parsed.type !== 'CUSTOM') throw new Error('expected CUSTOM fixture');
  return parsed;
};

export class FakeSmsSender {
  readonly calls: OutgoingSms[][] = [];
  failuresRemaining = 0;
  send(messages: OutgoingSms[]): Promise<SmsSendResult> {
    this.calls.push(messages);
    const failed = this.failuresRemaining !== 0;
    if (this.failuresRemaining > 0) this.failuresRemaining -= 1;
    return Promise.resolve({
      total: messages.length,
      failedTo: failed ? messages.map((m) => m.to) : [],
    });
  }
}

// Fault injection touches only completion; claims/counters/TTLs use real Redis.
export class CompletionFaultStore extends SmsEventDedupeStore {
  constructor(
    redis: Redis,
    private readonly deniedStore: SmsEventDedupeStore,
  ) {
    super(redis);
  }
  completionFailures = 0;
  completionAttempts = 0;
  claims = 0;
  override async claim(id: string) {
    this.claims += 1;
    return super.claim(id);
  }
  override async complete(id: string): Promise<void> {
    this.completionAttempts += 1;
    if (this.completionFailures > 0) {
      this.completionFailures -= 1;
      await this.deniedStore.complete(id);
      return;
    }
    await super.complete(id);
  }
}

export class CustomRuntime {
  readonly kafka: ObservedKafka;
  private readonly deadline = Date.now() + 45000;
  readonly redis: Redis;
  private readonly deniedRedis: Redis;
  readonly sender = new FakeSmsSender();
  readonly store: CompletionFaultStore;
  readonly config: AppConfig;
  readonly admin: Admin;
  readonly producer: Producer;
  private module?: TestingModule;

  constructor(infra: LocalInfra) {
    const config = createAppConfig();
    const prefix = `${infra.namespace}-${randomUUID()}`;
    this.config = createAppConfig({
      kafka: {
        ...config.kafka,
        brokers: [`127.0.0.1:${infra.kafkaPort}`],
        clientId: prefix,
        smsGroupId: `${prefix}.group`,
        topics: {
          ...config.kafka.topics,
          smsRequested: `${prefix}.requested`,
          smsDeadLetter: `${prefix}.dlq`,
          qrSmsSent: `${prefix}.qr`,
        },
      },
      sms: {
        ...config.sms,
        fromStandardNumber: '0000000001',
        fromTraineeNumber: '0000000002',
        eventMaxAttempts: 3,
      },
    });
    this.kafka = new ObservedKafka({
      brokers: this.config.kafka.brokers,
      clientId: prefix,
      logLevel: logLevel.NOTHING,
      connectionTimeout: 1000,
      requestTimeout: 3000,
      retry: { initialRetryTime: 100, maxRetryTime: 1000, retries: 10 },
    });
    this.redis = new Redis({
      host: '127.0.0.1',
      port: infra.redisPort,
      lazyConnect: true,
      retryStrategy: () => 100,
    });
    this.redis.on('error', () => undefined);
    this.deniedRedis = new Redis({
      host: '127.0.0.1',
      port: infra.redisPort,
      username: 'completion-denied',
      password: 'synthetic-only',
      lazyConnect: true,
    });
    this.deniedRedis.on('error', () => undefined);
    this.store = new CompletionFaultStore(
      this.redis,
      new SmsEventDedupeStore(this.deniedRedis),
    );
    this.admin = this.kafka.admin();
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
  }

  async prepare(): Promise<void> {
    await this.redis.connect();
    await this.redis.acl(
      'SETUSER',
      'completion-denied',
      'on',
      '>synthetic-only',
      '~*',
      '-@all',
      '+ping',
      '+info',
      '+client',
    );
    await this.deniedRedis.connect();
    await this.admin.connect();
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: [
        this.config.kafka.topics.smsRequested,
        this.config.kafka.topics.smsDeadLetter,
        this.config.kafka.topics.qrSmsSent,
      ].map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
    });
    await this.producer.connect();
  }

  async start(): Promise<void> {
    const before = this.kafka.fetches.get(this.config.kafka.smsGroupId) ?? 0;
    this.module = await Test.createTestingModule({
      providers: [
        SmsEventConsumer,
        SmsEventService,
        SmsEventGuard,
        { provide: APP_CONFIG, useValue: this.config },
        { provide: KAFKA_CLIENT, useValue: this.kafka },
        { provide: SmsEventDedupeStore, useValue: this.store },
        { provide: SmsSenderProvider, useValue: this.sender },
      ],
    }).compile();
    await this.module.init();
    await this.wait(
      () =>
        (this.kafka.fetches.get(this.config.kafka.smsGroupId) ?? 0) > before,
    );
  }

  async wait(check: () => boolean | Promise<boolean>): Promise<void> {
    await until(check, this.deadline);
  }

  async publish(payload: ReturnType<typeof event>): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.topics.smsRequested,
      messages: [{ key: payload.eventId, value: JSON.stringify(payload) }],
    });
  }

  async committed(offset: number): Promise<void> {
    await this.wait(async () => {
      const offsets = await this.admin.fetchOffsets({
        groupId: this.config.kafka.smsGroupId,
        topics: [this.config.kafka.topics.smsRequested],
      });
      return Number(offsets[0]?.partitions[0]?.offset ?? -1) >= offset;
    });
  }

  async stopConsumer(): Promise<void> {
    await this.module?.close();
    this.module = undefined;
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.stopConsumer(),
      this.producer.disconnect(),
      this.admin.disconnect(),
    ]);
    try {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) =>
          result.reason instanceof Error
            ? result.reason
            : new Error('test client cleanup failed'),
        );
      if (errors.length)
        throw new AggregateError(errors, 'test client cleanup failed');
    } finally {
      this.redis.disconnect();
      this.deniedRedis.disconnect();
    }
  }
}
