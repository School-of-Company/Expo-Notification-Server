import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { InternalCallError } from '../common/internal-http';
import { PromotionOfferApplicationProvider } from './promotion-offer-application.provider';
import {
  PromotionOfferInvalidCheckError,
  PromotionOfferRetryError,
} from './promotion-offer.schema';
import type { PromotionOfferRecord } from './promotion-offer.schema';

describe('promotion offer Application report', () => {
  const record: PromotionOfferRecord = {
    event: {
      version: 1,
      eventId: randomUUID(),
      offerId: randomUUID(),
      expoId: randomUUID(),
    },
    status: 'ACCEPTED',
    failures: 0,
    attemptId: randomUUID(),
    attemptedAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: '2030-01-01T00:00:01.000Z',
    report: 'ACCEPTED',
  };
  const provider = new PromotionOfferApplicationProvider(
    createAppConfig({
      promotionOffer: {
        enabled: true,
        application: {
          baseUrl: 'https://application.test',
          internalToken: 'x'.repeat(32),
        },
        internalToken: 'y'.repeat(32),
        topic: 'application.promotion-offer.requested',
        groupId: 'expo-notification-server.promotion-offer',
      },
    }),
  );
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [200, 'recorded'],
    [400, 'rejected'],
    [404, 'rejected'],
    [409, 'stale'],
    [500, 'retry'],
    [503, 'retry'],
  ])('maps %i to %s', async (status, outcome) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status }));
    await expect(provider.report(record)).resolves.toBe(outcome);
  });

  it('retries when Application is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('synthetic'));
    await expect(provider.report(record)).resolves.toBe('retry');
  });

  describe('check (#95)', () => {
    const eligible = {
      eligible: true,
      eventId: record.event.eventId,
      offerId: record.event.offerId,
      expoId: record.event.expoId,
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
    };
    const respond = (body: unknown) =>
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(Response.json(body, { status: 200 }));

    it('accepts a contract response', async () => {
      respond(eligible);
      await expect(provider.check(record.event)).resolves.toMatchObject({
        eligible: true,
      });
    });

    it.each([
      ['a location with a line break', { ...eligible, location: '1층\n2층' }],
      [
        'a 101-character name',
        { ...eligible, recipientName: '가'.repeat(101) },
      ],
      ['a missing field', { ...eligible, title: undefined }],
      ['an unknown ineligible reason', { eligible: false, reason: 'EXPIRED' }],
      ['another event', { ...eligible, eventId: randomUUID() }],
    ])('marks %s as an invalid response, not a retry', async (_, body) => {
      respond(body);
      await expect(provider.check(record.event)).rejects.toBeInstanceOf(
        PromotionOfferInvalidCheckError,
      );
    });

    it.each([502, 503])('keeps %i retryable', async (status) => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status }));
      await expect(provider.check(record.event)).rejects.toBeInstanceOf(
        InternalCallError,
      );
    });

    it('keeps an unreachable Application retryable', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('synthetic'));
      await expect(provider.check(record.event)).rejects.toBeInstanceOf(
        InternalCallError,
      );
    });

    it('keeps a missing connection retryable', async () => {
      await expect(
        new PromotionOfferApplicationProvider(createAppConfig()).check(
          record.event,
        ),
      ).rejects.toBeInstanceOf(PromotionOfferRetryError);
    });
  });
});
