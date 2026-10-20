import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { PromotionOfferApplicationProvider } from './promotion-offer-application.provider';
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
});
