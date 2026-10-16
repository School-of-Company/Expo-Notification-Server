import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { LocalInfra } from './local-infra';
import { PromotionRuntime } from './promotion-runtime';
import { eligible, promoted } from './promotion-fixture';

describe('promotion HTTP/Kafka/Redis contracts with synthetic SMS', () => {
  const infra = new LocalInfra();
  let runtime: PromotionRuntime;
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await infra.start();
  });
  beforeEach(async () => {
    runtime = new PromotionRuntime(infra);
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
    }
  });

  it('consumes backlog and duplicates, sends one per promotion to representative, sends reapplication with new ID', async () => {
    const first = promoted();
    await runtime.publish(first);
    await runtime.publish(first);
    await runtime.publish({
      ...first,
      eventId: promoted().eventId,
      applicationId: promoted().applicationId,
    });
    await runtime.start();
    await runtime.committed(3);
    expect(runtime.http.sms).toHaveLength(2);
    expect(runtime.http.sms[0]).toMatchObject({
      to: '01000000000',
      from: '0623804504',
    });
    expect(runtime.http.sms[0]?.text).toContain('[AI 미래교육 페스타]');
    expect(runtime.http.sms[0]?.text).toContain(
      '동행자님의 프로그램 신청이 확정',
    );
    expect(runtime.http.sms[0]?.text).toContain('미래 수업');
    expect(runtime.http.sms[0]?.text).toContain('10:00');
    expect(runtime.http.sms[0]?.text).not.toMatch(/장소:|신청 조회:|확정 버튼/);
    expect((await runtime.store.get(first.eventId))?.status).toBe('ACCEPTED');
    expect(
      await runtime.redis.ttl(
        `promotion:{notifications}:record:${first.eventId}`,
      ),
    ).toBe(-1);
    await runtime.service.handle(first);
    expect(runtime.http.sms).toHaveLength(2);
  });

  it('handles multiple STANDARD/TRAINING promotions and nullable trainee phone using representative phone', async () => {
    runtime.http.checkResponse = (event) => ({
      ...eligible(event),
      eligible: true,
      ...event,
      status: 'CONFIRMED',
      representativePhoneNumber: '01000000000',
      participantName: '연수 동행자',
      programName: '연수 수업',
      startedAt: '2026-10-13T01:00:00Z',
      endedAt: '2026-10-13T02:00:00Z',
      location: '행사장 A',
      applicationLookupUrl: 'https://expo.test/my-applications',
    });
    await runtime.start();
    const events = [
      promoted(),
      { ...promoted(), programType: 'TRAINING' as const },
      promoted(),
    ];
    for (const event of events) await runtime.publish(event);
    await runtime.committed(3);
    expect(runtime.http.sms).toHaveLength(3);
    expect(runtime.http.sms.map((sms) => sms.to)).toEqual(
      Array(3).fill('01000000000'),
    );
    expect(runtime.http.sms[1]?.from).toBe('0623804587');
    expect(runtime.http.sms[1]?.text).toContain('장소: 행사장 A');
    expect(runtime.http.sms[1]?.text).toContain(
      '신청 조회: https://expo.test/my-applications',
    );
  });

  it('accepts a 255-code-point supplementary-plane location from promotion check and rejects 256', async () => {
    runtime.http.checkResponse = (event) => ({
      ...eligible(event),
      location: '😀'.repeat(255),
    });
    await runtime.start();
    const accepted = promoted();
    await runtime.publish(accepted);
    await runtime.committed(1);
    expect(runtime.http.sms).toHaveLength(1);
    expect(runtime.http.sms[0]?.text).toContain(`장소: ${'😀'.repeat(255)}`);

    runtime.http.checkResponse = (event) => ({
      ...eligible(event),
      location: '😀'.repeat(256),
    });
    const rejected = promoted();
    await runtime.publish(rejected);
    await runtime.committed(2);
    expect(runtime.http.sms).toHaveLength(1);
    expect(await runtime.store.get(rejected.eventId)).toMatchObject({
      status: 'PENDING',
      reason: 'LOOKUP_UNAVAILABLE',
    });
  });

  it('stores missing representative phone for operations and does not automatically retry', async () => {
    runtime.http.checkResponse = (event) => {
      const check = eligible(event);
      return check.eligible
        ? { ...check, representativePhoneNumber: null }
        : check;
    };
    await runtime.start();
    const event = { ...promoted(), programType: 'TRAINING' as const };
    await runtime.publish(event);
    await runtime.committed(1);
    await runtime.service.handle(event);
    await runtime.retry(event.eventId);
    expect(runtime.http.sms).toHaveLength(0);
    expect(runtime.http.checks).toHaveLength(1);
    expect(await runtime.store.get(event.eventId)).toMatchObject({
      status: 'OPERATIONS',
      failures: 0,
      reason: 'MISSING_REPRESENTATIVE_PHONE',
    });
    expect(
      await runtime.redis.zscore(
        'promotion:{notifications}:due',
        event.eventId,
      ),
    ).toBeNull();
  });

  it.each(['CANCELLED', 'REPLACED', 'NOT_CURRENT_PROMOTION'] as const)(
    'skips %s after current application check',
    async (reason) => {
      runtime.http.checkResponse = () => ({ eligible: false, reason });
      await runtime.start();
      const event = promoted();
      await runtime.publish(event);
      await runtime.committed(1);
      expect(runtime.http.sms).toHaveLength(0);
      expect(await runtime.store.get(event.eventId)).toMatchObject({
        status: 'SKIPPED',
        reason,
      });
    },
  );

  it('retries transient lookup failure without consuming send budget and rechecks cancellation on retry', async () => {
    runtime.http.lookupFailures = 1;
    await runtime.start();
    const event = promoted();
    await runtime.publish(event);
    await runtime.committed(1);
    expect(await runtime.store.get(event.eventId)).toMatchObject({
      status: 'PENDING',
      failures: 0,
    });
    runtime.http.checkResponse = () => ({
      eligible: false,
      reason: 'CANCELLED',
    });
    await runtime.retry(event.eventId);
    expect(runtime.http.sms).toHaveLength(0);
    expect((await runtime.store.get(event.eventId))?.status).toBe('SKIPPED');
  });

  it('limits confirmed rejection to five attempts with stable eventId and distinct attempt IDs', async () => {
    runtime.http.sendMode = 'rejected';
    await runtime.start();
    const event = promoted();
    await runtime.publish(event);
    await runtime.committed(1);
    for (let i = 0; i < 6; i++) await runtime.service.handle(event);
    expect(runtime.http.sms).toHaveLength(5);
    expect(new Set(runtime.http.sms.map((sms) => sms.eventId))).toEqual(
      new Set([event.eventId]),
    );
    expect(new Set(runtime.http.sms.map((sms) => sms.attemptId)).size).toBe(5);
    expect(await runtime.store.get(event.eventId)).toMatchObject({
      status: 'OPERATIONS',
      failures: 5,
    });
  });

  it.each(['timeout', '503', 'malformed'] as const)(
    'preserves %s as unknown and only resumes after verified provider failure',
    async (mode) => {
      runtime.http.sendMode = mode;
      await runtime.start();
      const event = promoted();
      await runtime.publish(event);
      await runtime.committed(1);
      await runtime.service.handle(event);
      await runtime.retry(event.eventId);
      expect(runtime.http.sms).toHaveLength(1);
      expect((await runtime.store.get(event.eventId))?.status).toBe('UNKNOWN');
      const messageId = runtime.http.sms[0]?.messageId;
      if (!messageId) throw new Error('missing fake receipt');
      runtime.http.deliveryEventId = promoted().eventId;
      await expect(
        runtime.service.process(event.eventId, messageId),
      ).rejects.toThrow();
      runtime.http.deliveryEventId = undefined;
      runtime.http.deliveryMissing = true;
      await expect(
        runtime.service.process(event.eventId, messageId),
      ).rejects.toThrow();
      expect(runtime.http.sms).toHaveLength(1);
      runtime.http.deliveryMissing = false;
      runtime.http.deliveryStatus = 'COMPLETE';
      runtime.http.deliveryCode = '5004';
      await runtime.service.process(event.eventId, messageId);
      expect(await runtime.store.get(event.eventId)).toMatchObject({
        status: 'PENDING',
        failures: 1,
      });
      runtime.http.sendMode = 'accepted';
      await runtime.retry(event.eventId);
      expect(runtime.http.sms).toHaveLength(2);
    },
  );

  it('separates acceptance from final delivery and protects operations HTTP routes', async () => {
    await runtime.start();
    const event = promoted();
    await runtime.publish(event);
    await runtime.committed(1);
    if (!runtime.app) throw new Error('missing app');
    const server = runtime.app.getHttpServer();
    const path = `/internal/promotion-notifications/${event.eventId}`;
    await request(server).get(path).expect(403);
    await request(server)
      .get(path)
      .set('X-Internal-Token', 'o'.repeat(32))
      .expect(200);
    await request(server)
      .post(`${path}/reconciliation`)
      .set('X-Internal-Token', 'o'.repeat(32))
      .send({ messageId: '' })
      .expect(400);
    runtime.http.resultFailures = 1;
    await expect(runtime.service.process(event.eventId)).rejects.toThrow();
    expect((await runtime.store.get(event.eventId))?.status).toBe('ACCEPTED');
    runtime.http.deliveryStatus = 'COMPLETE';
    runtime.http.deliveryCode = '4000';
    await runtime.retry(event.eventId);
    expect((await runtime.store.get(event.eventId))?.status).toBe('DELIVERED');
    expect(runtime.http.sms).toHaveLength(1);
  });
});
