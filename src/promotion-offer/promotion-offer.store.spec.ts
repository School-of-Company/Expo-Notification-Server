import type { Redis } from 'ioredis';
import { PromotionOfferStore } from './promotion-offer.store';
import type { PromotionOfferRecord } from './promotion-offer.schema';

const record = (
  status: PromotionOfferRecord['status'],
): PromotionOfferRecord => ({
  event: {
    version: 1,
    eventId: '00000000-0000-4000-8000-000000000001',
    offerId: '00000000-0000-4000-8000-000000000002',
    expoId: '00000000-0000-4000-8000-000000000003',
  },
  status,
  failures: 0,
});

describe('PromotionOfferStore.save due time', () => {
  const now = Date.parse('2029-12-31T01:00:00.000Z');
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  const dueOf = async (saved: PromotionOfferRecord) => {
    const evalMock = jest.fn().mockResolvedValue(1);
    await new PromotionOfferStore({
      eval: evalMock,
    } as unknown as Redis).save(saved, 'token');
    // eval(script, 3, record, lock, queue, token, json, due, id)
    return (evalMock.mock.calls[0] as unknown[])[7];
  };

  it('keeps SENDING queued so a stale attempt is picked up again (#90)', async () => {
    expect(await dueOf(record('SENDING'))).toBe(now + 5 * 60_000);
  });

  it('drops a final result without a pending report from the queue', async () => {
    expect(await dueOf(record('UNKNOWN'))).toBe(0);
  });
});
