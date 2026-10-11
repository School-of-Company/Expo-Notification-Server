import { Logger } from '@nestjs/common';
import { CustomRuntime, event } from './custom-runtime';
import { LocalInfra } from './local-infra';
import type { KafkaMessage } from 'kafkajs';

describe('CUSTOM with isolated Kafka/Redis and fake sender', () => {
  const infra = new LocalInfra();
  let runtime: CustomRuntime;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await infra.start();
  });
  beforeEach(async () => {
    runtime = new CustomRuntime(infra);
    await runtime.prepare();
  });
  afterEach(async () => {
    await runtime?.close();
  });
  afterAll(() => {
    try {
      infra.stop();
    } finally {
      jest.restoreAllMocks();
      Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    }
  });

  it('selects TRAINEE sender, preserves CUSTOM body, suppresses same ID and sends new ID', async () => {
    const payload = event();
    await runtime.start();
    await runtime.publish(payload);
    await runtime.publish(payload);
    await runtime.publish({ ...payload, eventId: event().eventId });
    await runtime.committed(3);
    expect(runtime.sender.calls.length).toBe(2);
    expect(
      runtime.sender.calls.every(
        (batch) =>
          batch.length === 1 &&
          batch[0]?.from === runtime.config.sms.fromTraineeNumber &&
          batch[0]?.to === '01000000000' &&
          batch[0]?.text === payload.text,
      ),
    ).toBe(true);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
      'done-v2',
    );
    const ttl = await runtime.redis.ttl(`sms:event:${payload.eventId}`);
    expect(ttl).toBeGreaterThan(604740);
    expect(ttl).toBeLessThanOrEqual(604800);
    const qr = await runtime.admin.fetchTopicOffsets(
      runtime.config.kafka.topics.qrSmsSent,
    );
    expect(qr[0]?.offset).toBe('0');
    expect(
      await runtime.redis.exists(`sms:event-published:${payload.eventId}`),
    ).toBe(0);
  });

  it('retries total failures, moves original to DLQ, clears counter and recovers same ID', async () => {
    await runtime.start();
    const payload = event();
    runtime.sender.failuresRemaining = -1;
    await runtime.publish(payload);
    await runtime.committed(1);
    expect(runtime.sender.calls.length).toBe(3);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBeNull();
    expect(
      await runtime.redis.get(`sms:event-fail:${payload.eventId}`),
    ).toBeNull();
    const dlq = runtime.kafka.consumer({
      groupId: `${runtime.config.kafka.smsGroupId}.reader`,
    });
    let received: KafkaMessage | undefined;
    try {
      await dlq.connect();
      await dlq.subscribe({
        topic: runtime.config.kafka.topics.smsDeadLetter,
        fromBeginning: true,
      });
      await dlq.run({
        eachMessage: ({ message }) => {
          received = message;
          return Promise.resolve();
        },
      });
      await runtime.wait(() => received !== undefined);
      if (!received) throw new Error('missing DLQ message');
      expect(received.key?.toString() === payload.eventId).toBe(true);
      expect(received.value?.toString() === JSON.stringify(payload)).toBe(true);
      expect(received.headers?.['x-source-topic']?.toString()).toBe(
        runtime.config.kafka.topics.smsRequested,
      );
      runtime.sender.failuresRemaining = 1;
      await runtime.producer.send({
        topic: runtime.config.kafka.topics.smsRequested,
        messages: [{ key: received.key, value: received.value }],
      });
      await runtime.committed(2);
      expect(runtime.sender.calls.length).toBe(5);
      expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
        'done-v2',
      );
      expect(await runtime.redis.get(`sms:event-fail:${payload.eventId}`)).toBe(
        '1',
      );
      expect(
        (
          await runtime.admin.fetchTopicOffsets(
            runtime.config.kafka.topics.smsDeadLetter,
          )
        )[0]?.offset,
      ).toBe('1');
    } finally {
      await dlq.disconnect();
    }
  });

  it('keeps processing waits out of failure budget and resumes after lease release', async () => {
    await runtime.start();
    const payload = event();
    await runtime.redis.set(
      `sms:event:${payload.eventId}`,
      'processing',
      'EX',
      300,
    );
    const claimsBefore = runtime.store.claims;
    await runtime.publish(payload);
    await runtime.wait(() => runtime.store.claims >= claimsBefore + 4);
    expect(runtime.sender.calls.length).toBe(0);
    expect(
      await runtime.redis.get(`sms:event-fail:${payload.eventId}`),
    ).toBeNull();
    expect(
      (
        await runtime.admin.fetchTopicOffsets(
          runtime.config.kafka.topics.smsDeadLetter,
        )
      )[0]?.offset,
    ).toBe('0');
    await runtime.redis.del(`sms:event:${payload.eventId}`);
    await runtime.committed(1);
    expect(runtime.sender.calls.length).toBe(1);
  });

  it('retains lease after three completion failures and suppresses immediate redelivery', async () => {
    await runtime.start();
    const payload = event();
    runtime.store.completionFailures = 3;
    const attemptsBefore = runtime.store.completionAttempts;
    await runtime.publish(payload);
    await runtime.committed(1);
    expect(runtime.store.completionAttempts - attemptsBefore).toBe(3);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
      'processing',
    );
    expect(
      await runtime.redis.ttl(`sms:event:${payload.eventId}`),
    ).toBeGreaterThan(240);
    const claimsBefore = runtime.store.claims;
    await runtime.publish(payload);
    await runtime.wait(() => runtime.store.claims >= claimsBefore + 4);
    expect(runtime.sender.calls.length).toBe(1);
    expect(
      await runtime.redis.get(`sms:event-fail:${payload.eventId}`),
    ).toBeNull();
    await runtime.stopConsumer();
  });

  it('demonstrates duplicate risk after successful send and failed marker lease expiry', async () => {
    await runtime.start();
    const payload = event();
    runtime.store.completionFailures = 3;
    await runtime.publish(payload);
    await runtime.committed(1);
    await runtime.redis.pexpire(`sms:event:${payload.eventId}`, 1);
    await runtime.wait(
      async () =>
        (await runtime.redis.exists(`sms:event:${payload.eventId}`)) === 0,
    );
    await runtime.publish(payload);
    await runtime.committed(2);
    expect(runtime.sender.calls.length).toBe(2);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
      'done-v2',
    );
  });

  it('recovers transient Redis completion errors within three attempts', async () => {
    await runtime.start();
    const payload = event();
    runtime.store.completionFailures = 2;
    const before = runtime.store.completionAttempts;
    await runtime.publish(payload);
    await runtime.publish(payload);
    await runtime.committed(2);
    expect(runtime.store.completionAttempts - before).toBe(3);
    expect(runtime.sender.calls.length).toBe(1);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
      'done-v2',
    );
  });

  it('starts a new group at latest and skips messages published before subscription', async () => {
    const old = event();
    await runtime.publish(old);
    await runtime.start();
    expect(runtime.sender.calls.length).toBe(0);
    expect(await runtime.redis.get(`sms:event:${old.eventId}`)).toBeNull();
    const fresh = event();
    await runtime.publish(fresh);
    await runtime.committed(2);
    expect(runtime.sender.calls.length).toBe(1);
    expect(await runtime.redis.get(`sms:event:${fresh.eventId}`)).toBe(
      'done-v2',
    );
  });

  it('resumes committed offsets on restart, consumes offline traffic and suppresses replay', async () => {
    await runtime.start();
    const original = event();
    await runtime.publish(original);
    await runtime.committed(1);
    await runtime.stopConsumer();
    const offline = event();
    await runtime.publish(offline);
    await runtime.publish(original);
    await runtime.start();
    await runtime.committed(3);
    expect(runtime.sender.calls.length).toBe(2);
    expect(await runtime.redis.get(`sms:event:${offline.eventId}`)).toBe(
      'done-v2',
    );
  });
});
