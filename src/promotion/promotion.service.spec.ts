import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import type { ExpoNameProvider } from '../common/expo-name.provider';
import type { PromotionApplicationProvider } from './promotion-application.provider';
import type { PromotionSolapiProvider } from './promotion-solapi.provider';
import type { PromotionCheck, PromotionRecord } from './promotion.schema';
import { PromotionService } from './promotion.service';
import type { PromotionStore } from './promotion.store';

const event = {
  version: 1 as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  expoId: '33333333-3333-4333-8333-333333333333',
  participantId: 1,
  programType: 'STANDARD' as const,
  programId: 2,
};
const check: PromotionCheck = {
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
const text = [
  '[광주 박람회] 프로그램 대기 승급 안내',
  '홍길동님의 프로그램 신청이 확정되었습니다.',
  '프로그램: 미래 수업',
  '일시: 2026. 10. 31. 10:00 ~ 2026. 10. 31. 11:00 (한국시간)',
  '장소: 추후 안내',
  '신청 조회: 신청시스템에서 확인해 주세요',
].join('\n');

describe('PromotionService 승급 안내(K3)', () => {
  const config = createAppConfig();
  const send = jest.fn<
    ReturnType<PromotionSolapiProvider['send']>,
    Parameters<PromotionSolapiProvider['send']>
  >();
  const titleOf = jest.fn<Promise<string>, [string | undefined]>();
  let service: PromotionService;

  beforeEach(() => {
    config.kakao = undefined;
    send.mockReset().mockResolvedValue({ kind: 'unknown' });
    titleOf.mockReset().mockResolvedValue('광주 박람회');
    const record: PromotionRecord = { event, status: 'PENDING', failures: 0 };
    const store = {
      claim: jest.fn().mockResolvedValue('token'),
      get: jest.fn().mockResolvedValue(record),
      save: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    service = new PromotionService(
      config,
      store as unknown as PromotionStore,
      {
        check: jest.fn().mockResolvedValue(check),
      } as unknown as PromotionApplicationProvider,
      { send } as unknown as PromotionSolapiProvider,
      { titleOf } as unknown as ExpoNameProvider,
    );
  });

  it('박람회 제목과 빈 장소·조회 주소 대체 문구로 문자로만 보낸다', async () => {
    await service.process(event.eventId);

    expect(titleOf).toHaveBeenCalledWith(event.expoId);
    expect(send.mock.calls[0]?.[1]).toStrictEqual({
      to: '01012345678',
      from: config.sms.fromStandardNumber,
      text,
    });
  });

  it('templateId가 있으면 같은 문구에 대체 발송을 켠 kakaoOptions를 붙인다', async () => {
    config.kakao = { pfId: 'pf-1', auto: { promotion: 'k3' } };

    await service.process(event.eventId);

    expect(send.mock.calls[0]?.[1]).toEqual({
      to: '01012345678',
      from: config.sms.fromStandardNumber,
      text,
      kakaoOptions: {
        pfId: 'pf-1',
        templateId: 'k3',
        disableSms: false,
        variables: {
          '#{행사명}': '광주 박람회',
          '#{이름}': '홍길동',
          '#{프로그램}': '미래 수업',
          '#{일시}': '2026. 10. 31. 10:00 ~ 2026. 10. 31. 11:00 (한국시간)',
          '#{장소}': '추후 안내',
          '#{신청조회}': '신청시스템에서 확인해 주세요',
        },
      },
    });
  });
});
