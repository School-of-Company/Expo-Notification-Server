import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import type { PromotionSolapiProvider } from '../promotion/promotion-solapi.provider';
import type { PromotionOfferApplicationProvider } from './promotion-offer-application.provider';
import { promotionOfferMessage } from './promotion-offer-message';
import type {
  PromotionOfferCheck,
  PromotionOfferEvent,
  PromotionOfferRecord,
} from './promotion-offer.schema';
import { PromotionOfferService } from './promotion-offer.service';
import type { PromotionOfferStore } from './promotion-offer.store';

class MemoryStore {
  readonly records = new Map<string, PromotionOfferRecord>();
  enqueue(event: PromotionOfferEvent): Promise<void> {
    if (!this.records.has(event.eventId))
      this.records.set(event.eventId, {
        event,
        status: 'PENDING',
        failures: 0,
      });
    return Promise.resolve();
  }
  get(id: string): Promise<PromotionOfferRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }
  claim(): Promise<string> {
    return Promise.resolve('token');
  }
  save(record: PromotionOfferRecord): Promise<void> {
    this.records.set(record.event.eventId, record);
    return Promise.resolve();
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}

describe('promotion offer delivery', () => {
  const event: PromotionOfferEvent = {
    version: 1,
    eventId: randomUUID(),
    offerId: randomUUID(),
    expoId: randomUUID(),
  };
  const now = Date.parse('2029-12-31T01:00:00.000Z');
  const eligible = (
    overrides: Partial<Extract<PromotionOfferCheck, { eligible: true }>> = {},
  ): PromotionOfferCheck => ({
    eligible: true,
    eventId: event.eventId,
    offerId: event.offerId,
    expoId: event.expoId,
    target: 'PROGRAM',
    representativePhoneNumber: '01000000000',
    recipientName: '합성 대표자',
    title: '합성 프로그램',
    startedAt: '2030-01-01T11:00:00+09:00',
    endedAt: '2030-01-01T12:00:00+09:00',
    location: null,
    seats: 3,
    responseUrl: 'https://client.example/application/forms/x',
    hardDeadline: '2030-01-01T00:00:00Z',
    sendWindowEndsAt: '2029-12-31T09:00:00Z',
    responseHours: 6,
    ...overrides,
  });
  let store: MemoryStore;
  let check: jest.Mock;
  let report: jest.Mock;
  let send: jest.Mock;
  let delivery: jest.Mock;
  let service: PromotionOfferService;

  beforeEach(() => {
    jest.useFakeTimers({ now });
    store = new MemoryStore();
    check = jest.fn().mockResolvedValue(eligible());
    report = jest.fn().mockResolvedValue('recorded');
    send = jest.fn().mockImplementation(() => {
      // The provider answers after the attempt was recorded; acceptance is a later, real observation.
      jest.setSystemTime(now + 1500);
      return Promise.resolve({
        kind: 'accepted',
        groupId: 'group',
        messageId: 'message',
      });
    });
    delivery = jest.fn();
    service = new PromotionOfferService(
      createAppConfig(),
      store as unknown as PromotionOfferStore,
      { check, report } as unknown as PromotionOfferApplicationProvider,
      { send, delivery } as unknown as PromotionSolapiProvider,
    );
  });
  afterEach(() => jest.useRealTimers());

  const record = () => store.records.get(event.eventId)!;

  it('reports a real provider acceptance time distinct from the attempt and never sends twice', async () => {
    await service.handle(event);
    expect(send).toHaveBeenCalledTimes(1);
    expect(record()).toMatchObject({
      status: 'ACCEPTED',
      attemptedAt: new Date(now).toISOString(),
      acceptedAt: new Date(now + 1500).toISOString(),
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ report: 'ACCEPTED' }),
    );
    expect(record().report).toBeUndefined();
    // A redelivered Kafka message only polls the provider result.
    delivery.mockResolvedValue({
      kind: 'pending',
      groupId: 'group',
      messageId: 'message',
      code: '',
    });
    await service.handle(event);
    expect(send).toHaveBeenCalledTimes(1);
    expect(record().status).toBe('ACCEPTED');
  });

  it('keeps unknown acceptance for reconciliation, reports it, and does not resend', async () => {
    send.mockResolvedValue({ kind: 'unknown' });
    await service.handle(event);
    await service.process(event.eventId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(record().status).toBe('UNKNOWN');
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ report: 'UNKNOWN' }),
    );
    // Reconciliation only checks the provider; a still pending message keeps UNKNOWN without inventing acceptance.
    delivery.mockResolvedValue({
      kind: 'pending',
      groupId: 'group',
      messageId: 'found',
      code: '',
    });
    await service.process(event.eventId, 'found');
    expect(record()).toMatchObject({ status: 'UNKNOWN', messageId: 'found' });
    expect(record().acceptedAt).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips outside the send window and before any provider request', async () => {
    check.mockResolvedValue({
      eligible: false,
      reason: 'OUTSIDE_SEND_WINDOW',
    });
    await service.handle(event);
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        report: 'SKIPPED',
        reason: 'OUTSIDE_SEND_WINDOW',
      }),
    );
    store.records.clear();
    check.mockResolvedValue(
      eligible({ sendWindowEndsAt: new Date(now).toISOString() }),
    );
    await service.handle(event);
    expect(send).not.toHaveBeenCalled();
    expect(record().status).toBe('SKIPPED');
  });

  it('reports definitive failure for a missing phone and after five provider rejections', async () => {
    check.mockResolvedValue(eligible({ representativePhoneNumber: null }));
    await service.handle(event);
    expect(send).not.toHaveBeenCalled();
    expect(record()).toMatchObject({
      status: 'FAILED',
      reason: 'MISSING_REPRESENTATIVE_PHONE',
    });
    store.records.clear();
    check.mockResolvedValue(eligible());
    send.mockResolvedValue({ kind: 'rejected', code: '3059' });
    await service.handle(event);
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(record().status).toBe('PENDING');
      await service.process(event.eventId);
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(check).toHaveBeenCalledTimes(6);
    expect(record().status).toBe('FAILED');
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ report: 'FAILED' }),
    );
  });

  it('retries an unsent report without sending again and reports a later delivery failure', async () => {
    report.mockResolvedValueOnce('retry');
    await service.handle(event);
    expect(record().report).toBe('ACCEPTED');
    delivery.mockResolvedValue({
      kind: 'failed',
      groupId: 'group',
      messageId: 'message',
      code: '3059',
    });
    // The owed ACCEPTED report goes first, then the provider result is checked in the same pass.
    await service.process(event.eventId);
    expect(
      report.mock.calls.map(([sent]) => (sent as PromotionOfferRecord).report),
    ).toEqual(['ACCEPTED', 'ACCEPTED', 'FAILED']);
    expect(record().report).toBeUndefined();
    await service.process(event.eventId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(record()).toMatchObject({
      status: 'FAILED',
      reason: 'PROVIDER_DELIVERY_FAILED',
    });
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ report: 'FAILED' }),
    );
  });

  it('drops a report Application rejects with 400/404 instead of retrying it forever', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    report.mockResolvedValueOnce('rejected');
    await service.handle(event);
    // No owed report left, so the scheduler never re-sends it.
    expect(record().report).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: event.eventId,
        status: 'ACCEPTED',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('01000000000');
    warn.mockRestore();
  });

  it('shows a deadline never later than the real one and capped by the hard cutoff', () => {
    const attempt = new Date('2029-12-31T08:59:00Z');
    expect(
      promotionOfferMessage('박람회', eligible() as never, attempt),
    ).toContain('응답 기한: 2029. 12. 31. 23:59 (한국시간)');
    expect(
      promotionOfferMessage(
        '박람회',
        eligible({ hardDeadline: '2029-12-31T10:00:00Z' }) as never,
        attempt,
      ),
    ).toContain('응답 기한: 2029. 12. 31. 19:00 (한국시간)');
  });
});
