import { Logger } from '@nestjs/common';
import { CustomRuntime, event, qrEvent } from './custom-runtime';
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

  it('keeps SENDING for the done-marker TTL after three completion failures and never resends on redelivery or restart', async () => {
    await runtime.start();
    const payload = event();
    runtime.store.completionFailures = 3;
    const attemptsBefore = runtime.store.completionAttempts;
    await runtime.publish(payload);
    await runtime.committed(1);
    expect(runtime.store.completionAttempts - attemptsBefore).toBe(3);
    expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
      'sending',
    );
    // Not the 5-minute processing lease: expiry of that lease no longer reopens the event.
    expect(
      await runtime.redis.ttl(`sms:event:${payload.eventId}`),
    ).toBeGreaterThan(604000);
    await runtime.publish(payload);
    await runtime.committed(2);
    await runtime.stopConsumer();
    await runtime.publish(payload);
    await runtime.start();
    await runtime.committed(3);
    expect(runtime.sender.calls.length).toBe(1);
    expect(
      await runtime.redis.get(`sms:event-fail:${payload.eventId}`),
    ).toBeNull();
    const dlq = await runtime.readTopic(
      runtime.config.kafka.topics.smsDeadLetter,
      2,
    );
    expect(
      dlq.every(
        (m) =>
          m.headers?.['x-sms-delivery']?.toString() === 'UNKNOWN' &&
          m.key?.toString() === payload.eventId,
      ),
    ).toBe(true);
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

  describe('#46 provider accepted but the response was lost', () => {
    const unknownMarker = async (eventId: string) => ({
      state: await runtime.redis.get(`sms:event:${eventId}`),
      ttl: await runtime.redis.ttl(`sms:event:${eventId}`),
      failures: await runtime.redis.get(`sms:event-fail:${eventId}`),
    });

    it('connection drop after acceptance: no second send on redelivery or after the lease window; next events proceed', async () => {
      await runtime.start();
      const payload = event();
      runtime.sender.afterAccept = 'drop';
      await runtime.publish(payload);
      await runtime.committed(1);
      expect(runtime.sender.calls.length).toBe(1);
      expect(runtime.sender.eventIds).toEqual([payload.eventId]);
      const marker = await unknownMarker(payload.eventId);
      expect(marker.state).toBe('unknown');
      expect(marker.ttl).toBeGreaterThan(604000);
      expect(marker.failures).toBeNull();

      // Restart persistence is covered by the timeout case; kept short for the shared 45s deadline.
      runtime.sender.afterAccept = 'respond';
      await runtime.publish(payload);
      const next = event();
      await runtime.publish(next);
      await runtime.committed(3);

      expect(runtime.sender.eventIds).toEqual([payload.eventId, next.eventId]);
      expect(await runtime.redis.get(`sms:event:${next.eventId}`)).toBe(
        'done-v2',
      );
      const dlq = await runtime.readTopic(
        runtime.config.kafka.topics.smsDeadLetter,
        2,
      );
      expect(dlq).toHaveLength(2);
      expect(
        dlq.every(
          (m) =>
            m.key?.toString() === payload.eventId &&
            m.value?.toString() === JSON.stringify(payload) &&
            m.headers?.['x-sms-delivery']?.toString() === 'UNKNOWN',
        ),
      ).toBe(true);
    });

    it('response timeout after acceptance: single HTTP attempt, kept UNKNOWN across restart', async () => {
      // The synthetic provider accepts and never answers. Only the client deadline is
      // shortened (15s -> 1s) so the real AbortSignal path runs within the test budget.
      const timeout = AbortSignal.timeout.bind(AbortSignal) as (
        ms: number,
      ) => AbortSignal;
      const spy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => timeout(Math.min(ms, 1000)));
      try {
        await runtime.start();
        const payload = event();
        runtime.sender.afterAccept = 'hang';
        await runtime.publish(payload);
        await runtime.committed(1);
        expect(runtime.sender.calls.length).toBe(1);
        expect((await unknownMarker(payload.eventId)).state).toBe('unknown');

        runtime.sender.afterAccept = 'respond';
        await runtime.stopConsumer();
        await runtime.publish(payload);
        await runtime.start();
        await runtime.committed(2);
        expect(runtime.sender.calls.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('explicit rejection keeps bounded retries and releases the claim', async () => {
      await runtime.start();
      const payload = event();
      runtime.sender.failuresRemaining = 1;
      await runtime.publish(payload);
      await runtime.committed(1);
      expect(runtime.sender.calls.length).toBe(2);
      expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
        'done-v2',
      );
      expect(
        await runtime.topicSize(runtime.config.kafka.topics.smsDeadLetter),
      ).toBe(0);
    });

    it('CUSTOM with 1000 recipients and partial failure is sent once and completed', async () => {
      await runtime.start();
      const phoneNumbers = Array.from(
        { length: 1000 },
        (_, i) => `010${String(i).padStart(8, '0')}`,
      );
      const payload = { ...event(), phoneNumbers };
      runtime.sender.failedRecipients = new Set(phoneNumbers.slice(0, 3));
      await runtime.publish(payload);
      await runtime.publish(payload);
      await runtime.committed(2);
      expect(runtime.sender.calls.length).toBe(1);
      expect(runtime.sender.calls[0]).toHaveLength(1000);
      expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
        'done-v2',
      );
    });

    it('QR: drop after acceptance publishes no qr-sms.sent and never resends; operator done-v2 recovery publishes only', async () => {
      await runtime.start();
      const payload = qrEvent();
      runtime.sender.afterAccept = 'drop';
      await runtime.publishQr(payload);
      await runtime.committedQr(1);
      runtime.sender.afterAccept = 'respond';
      await runtime.publishQr(payload);
      await runtime.committedQr(2);
      expect(runtime.sender.calls.length).toBe(1);
      expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
        'unknown',
      );
      expect(
        await runtime.topicSize(runtime.config.kafka.topics.qrSmsSent),
      ).toBe(0);

      // Documented recovery after confirming delivery in the Solapi console.
      await runtime.redis.set(
        `sms:event:${payload.eventId}`,
        'done-v2',
        'EX',
        604800,
      );
      await runtime.publishQr(payload);
      await runtime.committedQr(3);
      expect(runtime.sender.calls.length).toBe(1);
      const sent = await runtime.readTopic(
        runtime.config.kafka.topics.qrSmsSent,
        1,
      );
      expect(sent[0]?.key?.toString()).toBe(payload.eventId);
    });

    it('QR: explicit rejection retries the SMS, then publish-only failures retry without resending', async () => {
      await runtime.start();
      const payload = qrEvent();
      runtime.sender.failuresRemaining = 1;
      runtime.qrPublishFailures = runtime.config.sms.eventMaxAttempts + 1;
      await runtime.publishQr(payload);
      await runtime.committedQr(1);
      await runtime.wait(
        async () =>
          (await runtime.topicSize(runtime.config.kafka.topics.qrSmsSent)) ===
          1,
      );
      expect(runtime.sender.calls.length).toBe(2);
      expect(runtime.qrPublishFailures).toBe(0);
      expect(await runtime.redis.get(`sms:event:${payload.eventId}`)).toBe(
        'done-v2',
      );
      expect(
        await runtime.topicSize(runtime.config.kafka.topics.smsDeadLetter),
      ).toBe(0);
    });
  });
});
