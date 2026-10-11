import { randomUUID } from 'node:crypto';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { PromotionSolapiProvider } from './promotion-solapi.provider';
import type { PromotionRecord } from './promotion.schema';

describe('promotion Solapi transport', () => {
  const record: PromotionRecord = {
    event: {
      version: 1,
      eventId: randomUUID(),
      applicationId: randomUUID(),
      expoId: randomUUID(),
      participantId: 1,
      programType: 'STANDARD',
      programId: 2,
    },
    status: 'SENDING',
    failures: 0,
    attemptId: randomUUID(),
  };
  const message = { to: '01000000000', from: '0000000001', text: 'synthetic' };
  afterEach(() => jest.restoreAllMocks());

  it('does not retry DOM timeout internally and classifies it as unknown', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new DOMException('synthetic timeout', 'TimeoutError'));
    const provider = new PromotionSolapiProvider(createAppConfig());
    await expect(provider.send(record, message)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry 503 or assume malformed acceptance is success', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }));
    const provider = new PromotionSolapiProvider(createAppConfig());
    await expect(provider.send(record, message)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response('{}'));
    await expect(provider.send(record, message)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps malformed delivery results and transport errors out of HTTP error logs', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('synthetic upstream details'));
    const provider = new PromotionSolapiProvider(createAppConfig());
    await expect(
      provider.delivery(record, 'synthetic-message'),
    ).resolves.toBeNull();
    fetch.mockRejectedValue(
      new DOMException('synthetic timeout', 'TimeoutError'),
    );
    await expect(
      provider.delivery(record, 'synthetic-message'),
    ).resolves.toBeNull();
  });
});
