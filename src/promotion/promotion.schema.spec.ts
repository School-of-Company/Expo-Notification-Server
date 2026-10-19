import { randomUUID } from 'node:crypto';
import { promotionCheckSchema, promotionEventSchema } from './promotion.schema';
import { appConfigSchema } from '../config/app-config';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { loadConfig } from '../config/load-config';
import { PromotionApplicationProvider } from './promotion-application.provider';

const event = {
  version: 1,
  eventId: randomUUID(),
  applicationId: randomUUID(),
  expoId: randomUUID(),
  participantId: 2,
  programType: 'TRAINING',
  programId: 3,
};
const response = {
  ...event,
  eligible: true,
  status: 'CONFIRMED',
  representativePhoneNumber: null,
  participantName: '참가자',
  programName: '프로그램',
  startedAt: '2026-10-13T01:00:00Z',
  endedAt: '2026-10-13T02:00:00Z',
  location: null,
  applicationLookupUrl: null,
};

describe('promotion boundary contracts', () => {
  afterEach(() => jest.restoreAllMocks());
  it('requires explicit version and safe IDs, accepts nullable representative phone', () => {
    expect(promotionEventSchema.safeParse(event).success).toBe(true);
    expect(
      promotionEventSchema.safeParse({ ...event, version: 2 }).success,
    ).toBe(false);
    expect(
      promotionEventSchema.safeParse({ ...event, participantId: 2 ** 53 })
        .success,
    ).toBe(false);
    expect(promotionCheckSchema.safeParse(response).success).toBe(true);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        representativePhoneNumber: '010-1234-1234',
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        applicationLookupUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        endedAt: response.startedAt,
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        participantName: 'name\nother',
      }).success,
    ).toBe(false);
  });
  it('limits only location to 255 code points while retaining label validation', () => {
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        location: '😀'.repeat(255),
      }).success,
    ).toBe(true);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        location: '😀'.repeat(256),
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        location: 'location\nother',
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        participantName: 'a'.repeat(101),
      }).success,
    ).toBe(false);
    expect(
      promotionCheckSchema.safeParse({
        ...response,
        programName: 'a'.repeat(101),
      }).success,
    ).toBe(false);
  });
  it('keeps feature disabled by default and defaults the expo name', () => {
    const config = createAppConfig();
    expect(appConfigSchema.parse(config).promotion).toBeUndefined();
    const { expoName: ignored, ...sms } = config.sms;
    void ignored;
    expect(appConfigSchema.parse({ ...config, sms }).sms.expoName).toBe(
      'AI 미래교육 페스타',
    );
  });
  it('rejects misspelled activation flags and incomplete connection config', () => {
    const config = createAppConfig();
    expect(
      appConfigSchema.safeParse({ ...config, promotion: { enabled: 'yes' } })
        .success,
    ).toBe(false);
    expect(
      appConfigSchema.safeParse({ ...config, promotion: { enabled: true } })
        .success,
    ).toBe(false);
  });
  it('loads promotion env contract without changing other service config', async () => {
    const config = await loadConfig(
      {
        CONFIG_SERVER_URL: 'http://config.test',
        PROMOTION_ENABLED: 'true',
        PROMOTION_APPLICATION_URL: 'http://application.test',
        PROMOTION_APPLICATION_INTERNAL_TOKEN: 'a'.repeat(32),
        PROMOTION_INTERNAL_TOKEN: 'o'.repeat(32),
        KAFKA_PROMOTION_TOPIC: 'promotion.test',
      },
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(createAppConfig()),
        }),
    );
    expect(config.promotion).toMatchObject({
      enabled: true,
      topic: 'promotion.test',
      application: { baseUrl: 'http://application.test' },
    });
  });
  it('rejects eligible snapshots for a different application or promotion', async () => {
    const config = createAppConfig({
      promotion: {
        enabled: true,
        application: {
          baseUrl: 'http://application.test',
          internalToken: 'a'.repeat(32),
        },
        internalToken: 'o'.repeat(32),
        topic: 'promotion.test',
        groupId: 'promotion.test',
        recoveryHold: false,
      },
    });
    const provider = new PromotionApplicationProvider(config);
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ...response, eventId: randomUUID() })),
      );
    await expect(
      provider.check(promotionEventSchema.parse(event)),
    ).rejects.toThrow();
    spy.mockResolvedValue(
      new Response(
        JSON.stringify({ ...response, applicationId: randomUUID() }),
      ),
    );
    await expect(
      provider.check(promotionEventSchema.parse(event)),
    ).rejects.toThrow();
    spy.mockResolvedValue(new Response('invalid json'));
    await expect(
      provider.check(promotionEventSchema.parse(event)),
    ).rejects.toThrow();
  });
});
