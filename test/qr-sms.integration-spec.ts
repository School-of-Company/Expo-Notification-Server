import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { APP_CONFIG } from '../src/config/app-config.constants';
import { KAFKA_CLIENT } from '../src/kafka/kafka.constants';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { ParticipantNamesProvider } from '../src/sms/participant-names.provider';
import { ParticipantRegisteredConsumer } from '../src/sms/participant-registered.consumer';
import { QrSmsSentPublisher } from '../src/sms/qr-sms-sent.publisher';
import { QrSmsService } from '../src/sms/qr-sms.service';
import { SmsEventDedupeStore } from '../src/sms/sms-event-dedupe.store';
import { SmsEventGuard } from '../src/sms/sms-event.guard';
import { SmsSenderProvider } from '../src/sms/sms-sender.provider';
import { createAppConfig } from './fixtures/app-config.fixture';

describe('QR SMS with real Kafka and Redis', () => {
  const kafka = new Kafka({
    brokers: ['127.0.0.1:29992'],
    logLevel: logLevel.NOTHING,
    retry: { initialRetryTime: 20, maxRetryTime: 100, retries: 2 },
  });
  const redis = new Redis({ host: '127.0.0.1', port: 26379 });
  const prefix = `qr-check-${Date.now()}`;
  const config = createAppConfig();
  config.kafka.smsGroupId = prefix;
  config.kafka.topics.participantRegistered = `${prefix}.registered`;
  config.kafka.topics.qrSmsSent = `${prefix}.sent`;
  config.kafka.topics.smsDeadLetter = `${prefix}.dlq`;
  const admin = kafka.admin();
  const producer = kafka.producer();
  const observer = kafka.consumer({ groupId: `${prefix}.observer` });
  const messages: { topic: string; key: string; value: unknown }[] = [];
  const sender = {
    deliver: jest.fn().mockResolvedValue({ kind: 'accepted', failedTo: [] }),
  };
  const names = {
    findNames: jest.fn().mockResolvedValue(new Map()),
  };
  let moduleRef: TestingModule;
  let publish: jest.SpyInstance;
  const event = (suffix: string, participationType = 'STANDARD') => ({
    eventId: `${prefix}-${suffix}`,
    expoId: 'expo-1',
    participationType,
    id: 42,
    phoneNumber: '01012345678',
    participants: [{ id: 42, code: 'a'.repeat(22) }],
  });
  const emit = (payload: ReturnType<typeof event>) =>
    producer.send({
      topic: config.kafka.topics.participantRegistered,
      messages: [{ key: payload.eventId, value: JSON.stringify(payload) }],
    });
  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('Kafka observation timed out');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await admin.connect();
    await admin.createTopics({
      topics: Object.values(config.kafka.topics)
        .filter((topic) => topic.startsWith(prefix))
        .map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
    });
    await producer.connect();
    await observer.connect();
    await observer.subscribe({
      topics: [
        config.kafka.topics.qrSmsSent,
        config.kafka.topics.smsDeadLetter,
      ],
      fromBeginning: true,
    });
    await observer.run({
      eachMessage: ({ topic, message }) => {
        messages.push({
          topic,
          key: message.key?.toString() ?? '',
          value: JSON.parse(message.value?.toString() ?? 'null'),
        });
        return Promise.resolve();
      },
    });
    moduleRef = await Test.createTestingModule({
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: KAFKA_CLIENT, useValue: kafka },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: ParticipantNamesProvider, useValue: names },
        { provide: SmsSenderProvider, useValue: sender },
        SmsEventDedupeStore,
        SmsEventGuard,
        QrSmsSentPublisher,
        QrSmsService,
        ParticipantRegisteredConsumer,
      ],
    }).compile();
    const publisher = moduleRef.get<QrSmsSentPublisher>(QrSmsSentPublisher);
    publish = jest
      .spyOn(publisher, 'publish')
      .mockImplementation(async (payload) => {
        if (
          payload.eventId.endsWith('-retry') &&
          publish.mock.calls.length <= 7
        ) {
          throw new Error('injected broker failure');
        }
        await QrSmsSentPublisher.prototype.publish.call(publisher, payload);
      });
    await moduleRef.init();
  }, 30000);

  afterAll(async () => {
    await moduleRef?.close();
    await observer.disconnect();
    await producer.disconnect();
    await admin.deleteTopics({
      topics: [
        config.kafka.topics.participantRegistered,
        config.kafka.topics.qrSmsSent,
        config.kafka.topics.smsDeadLetter,
      ],
    });
    await admin.disconnect();
    const keys = await redis.keys(`sms:*${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  }, 30000);

  it('automatically retries publishing beyond DLQ limit without sending SMS twice', async () => {
    const payload = event('retry');
    await emit(payload);
    await until(() =>
      messages.some((message) => message.key === payload.eventId),
    );
    expect(publish).toHaveBeenCalledTimes(8);
    expect(sender.deliver).toHaveBeenCalledTimes(1);
    expect(names.findNames).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([
      {
        topic: config.kafka.topics.qrSmsSent,
        key: payload.eventId,
        value: {
          eventId: payload.eventId,
          expoId: 'expo-1',
          participationType: 'STANDARD',
          id: 42,
        },
      },
    ]);
    expect(await redis.get(`sms:event:${payload.eventId}`)).toBe('done-v2');
    expect(await redis.get(`sms:event-fail:${payload.eventId}`)).toBeNull();
    await until(
      async () =>
        (await redis.exists(`sms:event-published:${payload.eventId}`)) === 1,
    );
    await emit(payload);
    // A following record proves the consumer passed the duplicate offset.
    const trainee = event('trainee', 'TRAINEE');
    await emit(trainee);
    await until(
      async () =>
        (await redis.get(`sms:event:${trainee.eventId}`)) === 'done-v2',
    );
    expect(publish).toHaveBeenCalledTimes(8);
    expect(sender.deliver).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
  }, 30000);

  it('waits for a processing lease to expire, then sends once without DLQ', async () => {
    const payload = event('processing');
    await redis.set(`sms:event:${payload.eventId}`, 'processing', 'EX', 2);
    const before = sender.deliver.mock.calls.length;
    await emit(payload);
    await until(() =>
      messages.some((message) => message.key === payload.eventId),
    );
    expect(sender.deliver).toHaveBeenCalledTimes(before + 1);
    expect(await redis.get(`sms:event-fail:${payload.eventId}`)).toBeNull();
    expect(
      messages.some(
        (message) => message.topic === config.kafka.topics.smsDeadLetter,
      ),
    ).toBe(false);
  }, 30000);

  it('moves send failures to DLQ and resets attempts for manual replay', async () => {
    const payload = event('dlq');
    sender.deliver.mockResolvedValue({ kind: 'rejected', code: '3059' });
    const before = sender.deliver.mock.calls.length;
    await emit(payload);
    await until(() =>
      messages.some(
        (message) => message.topic === config.kafka.topics.smsDeadLetter,
      ),
    );
    await until(
      async () =>
        (await redis.exists(`sms:event-fail:${payload.eventId}`)) === 0,
    );
    expect(sender.deliver).toHaveBeenCalledTimes(
      before + config.sms.eventMaxAttempts,
    );
    expect(await redis.get(`sms:event:${payload.eventId}`)).toBeNull();
    sender.deliver.mockResolvedValue({ kind: 'accepted', failedTo: [] });
    await emit(payload);
    await until(() =>
      messages.some(
        (message) =>
          message.key === payload.eventId &&
          message.topic === config.kafka.topics.qrSmsSent,
      ),
    );
    expect(sender.deliver).toHaveBeenCalledTimes(
      before + config.sms.eventMaxAttempts + 1,
    );
  }, 30000);

  it('does not publish a completion event for an HTTP-era done marker', async () => {
    const payload = event('legacy');
    const before = sender.deliver.mock.calls.length;
    const publishedBefore = publish.mock.calls.length;
    await redis.set(`sms:event:${payload.eventId}`, 'done', 'EX', 86400);
    await emit(payload);
    const barrier = event('legacy-barrier', 'TRAINEE');
    await emit(barrier);
    await until(
      async () =>
        (await redis.get(`sms:event:${barrier.eventId}`)) === 'done-v2',
    );

    expect(sender.deliver).toHaveBeenCalledTimes(before + 1);
    expect(publish).toHaveBeenCalledTimes(publishedBefore);
    expect(await redis.get(`sms:event:${payload.eventId}`)).toBe('done');
  }, 30000);
});
