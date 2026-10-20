import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { InternalCallError } from '../common/internal-http';
import { PromotionApplicationProvider } from './promotion-application.provider';
import { PromotionInvalidCheckError } from './promotion.schema';

const event = {
  version: 1 as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  expoId: '33333333-3333-4333-8333-333333333333',
  participantId: 1,
  programType: 'STANDARD' as const,
  programId: 2,
};
const eligible = {
  ...event,
  eligible: true,
  status: 'CONFIRMED',
  representativePhoneNumber: '01012345678',
  participantName: '홍길동',
  programName: '미래 수업',
  startedAt: '2026-10-31T01:00:00Z',
  endedAt: '2026-10-31T02:00:00Z',
  location: null,
  applicationLookupUrl: null,
};

describe('PromotionApplicationProvider check (#95)', () => {
  const provider = new PromotionApplicationProvider(
    createAppConfig({
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
    }),
  );
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['장소 줄바꿈', { ...eligible, location: '1층\n2층' }],
    ['필드 누락', { ...eligible, programName: undefined }],
    ['다른 승급', { ...eligible, programId: 3 }],
  ])('%s은 재시도 대상이 아닌 계약 위반으로 구분한다', async (_, body) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json(body, { status: 200 }));
    await expect(provider.check(event)).rejects.toBeInstanceOf(
      PromotionInvalidCheckError,
    );
  });

  it.each([502, 503])('%i은 재시도한다', async (status) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status }));
    await expect(provider.check(event)).rejects.toBeInstanceOf(
      InternalCallError,
    );
  });
});
