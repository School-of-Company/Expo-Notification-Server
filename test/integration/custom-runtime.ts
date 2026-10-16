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
import type { OutgoingSms } from '../../src/sms/sms-sender.provider';
import { SOLAPI_CLIENT } from '../../src/sms/sms.constants';
import { ParticipantNamesProvider } from '../../src/sms/participant-names.provider';
import { ParticipantRegisteredConsumer } from '../../src/sms/participant-registered.consumer';
import { participantRegisteredSchema } from '../../src/sms/participant-event.schema';
import { QrSmsSentPublisher } from '../../src/sms/qr-sms-sent.publisher';
import type { QrSmsSentEvent } from '../../src/sms/qr-sms-sent.publisher';
import { QrSmsService } from '../../src/sms/qr-sms.service';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { KafkaMessage } from 'kafkajs';
import { z } from 'zod';
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

export const qrEvent = () =>
  participantRegisteredSchema.parse({
    eventId: randomUUID(),
    expoId: 'synthetic-expo',
    participationType: 'STANDARD',
    id: 42,
    phoneNumber: '01000000000',
    participants: [{ id: 42, code: 'a'.repeat(22) }],
  });

/**
 * Synthetic Solapi send-many/detail endpoint. Real SmsSenderProvider/fetch reach it via a
 * rewritten URL; nothing leaves 127.0.0.1, so no paid SMS is sent.
 * - failuresRemaining: explicit rejection (every message registeredFailed), -1 = forever
 * - afterAccept: what happens after the request is recorded as accepted
 */
export class SyntheticSolapi {
  readonly calls: OutgoingSms[][] = [];
  readonly eventIds: string[] = [];
  failuresRemaining = 0;
  failedRecipients = new Set<string>();
  afterAccept: 'respond' | 'drop' | 'hang' = 'respond';
  url = '';
  private server?: Server;

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.respond(request, response).catch(() => response.destroy());
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing synthetic solapi port');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  private async respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Buffer));
    if (
      request.url !== '/messages/v4/send-many/detail' ||
      !String(request.headers.authorization).startsWith(
        'HMAC-SHA256 apiKey=key,',
      )
    ) {
      response.writeHead(404).end('{}');
      return;
    }
    const body = z
      .object({
        messages: z
          .array(
            z.object({
              to: z.string(),
              from: z.string(),
              text: z.string(),
              customFields: z.object({ eventId: z.string() }),
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const messages = body.messages.map(({ to, from, text }) => ({
      to,
      from,
      text,
    }));
    const rejectAll = this.failuresRemaining !== 0;
    if (this.failuresRemaining > 0) this.failuresRemaining -= 1;
    const failed = messages.filter(
      (m) => rejectAll || this.failedRecipients.has(m.to),
    );
    this.calls.push(messages);
    // Past this point without an explicit rejection, the provider has accepted the batch.
    if (!rejectAll) {
      this.eventIds.push(body.messages[0]?.customFields.eventId ?? '');
      if (this.afterAccept === 'drop') {
        request.socket.destroy();
        return;
      }
      if (this.afterAccept === 'hang') return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        groupInfo: {
          groupId: 'G-synthetic',
          count: {
            total: messages.length,
            registeredSuccess: messages.length - failed.length,
            registeredFailed: failed.length,
          },
        },
        failedMessageList: failed.map((m) => ({
          to: m.to,
          statusCode: '3059',
        })),
      }),
    );
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
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
  readonly sender = new SyntheticSolapi();
  qrPublishFailures = 0;
  private restoreFetch?: () => void;
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
          participantRegistered: `${prefix}.registered`,
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

  get qrGroupId(): string {
    return `${this.config.kafka.smsGroupId}.participant-registered`;
  }

  async prepare(): Promise<void> {
    await this.sender.start();
    const original = global.fetch;
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input, init) => {
        if (
          typeof input === 'string' &&
          input.startsWith('https://api.solapi.com/')
        )
          return original(
            input.replace('https://api.solapi.com', this.sender.url),
            init,
          );
        throw new Error('unexpected external request in SMS integration test');
      });
    this.restoreFetch = () => spy.mockRestore();
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
        this.config.kafka.topics.participantRegistered,
      ].map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
    });
    await this.producer.connect();
  }

  async start(): Promise<void> {
    const fetched = (group: string) => this.kafka.fetches.get(group) ?? 0;
    const before = fetched(this.config.kafka.smsGroupId);
    const qrBefore = fetched(this.qrGroupId);
    this.module = await Test.createTestingModule({
      providers: [
        SmsEventConsumer,
        SmsEventService,
        SmsEventGuard,
        SmsSenderProvider,
        ParticipantRegisteredConsumer,
        QrSmsService,
        QrSmsSentPublisher,
        { provide: APP_CONFIG, useValue: this.config },
        { provide: KAFKA_CLIENT, useValue: this.kafka },
        { provide: SmsEventDedupeStore, useValue: this.store },
        // The SDK client is only used by the OTP path; event sends must not touch it.
        { provide: SOLAPI_CLIENT, useValue: {} },
        {
          provide: ParticipantNamesProvider,
          useValue: { findNames: () => Promise.resolve(new Map()) },
        },
      ],
    }).compile();
    const publisher = this.module.get(QrSmsSentPublisher);
    const publish = publisher.publish.bind(publisher) as (
      event: QrSmsSentEvent,
    ) => Promise<void>;
    jest.spyOn(publisher, 'publish').mockImplementation((payload) => {
      if (this.qrPublishFailures > 0) {
        this.qrPublishFailures -= 1;
        return Promise.reject(new Error('injected broker failure'));
      }
      return publish(payload);
    });
    await this.module.init();
    await this.wait(
      () =>
        fetched(this.config.kafka.smsGroupId) > before &&
        fetched(this.qrGroupId) > qrBefore,
    );
  }

  async publishQr(payload: ReturnType<typeof qrEvent>): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.topics.participantRegistered,
      messages: [{ key: payload.eventId, value: JSON.stringify(payload) }],
    });
  }

  async committedQr(offset: number): Promise<void> {
    await this.wait(async () => {
      const offsets = await this.admin.fetchOffsets({
        groupId: this.qrGroupId,
        topics: [this.config.kafka.topics.participantRegistered],
      });
      return Number(offsets[0]?.partitions[0]?.offset ?? -1) >= offset;
    });
  }

  async topicSize(topic: string): Promise<number> {
    const offsets = await this.admin.fetchTopicOffsets(topic);
    return Number(offsets[0]?.offset ?? 0);
  }

  async readTopic(topic: string, count: number): Promise<KafkaMessage[]> {
    const reader = this.kafka.consumer({ groupId: `${topic}.${randomUUID()}` });
    const received: KafkaMessage[] = [];
    try {
      await reader.connect();
      await reader.subscribe({ topic, fromBeginning: true });
      await reader.run({
        eachMessage: ({ message }) => {
          received.push(message);
          return Promise.resolve();
        },
      });
      await this.wait(() => received.length >= count);
      return received;
    } finally {
      await reader.disconnect();
    }
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
      this.restoreFetch?.();
      await this.sender.close();
      this.redis.disconnect();
      this.deniedRedis.disconnect();
    }
  }
}
