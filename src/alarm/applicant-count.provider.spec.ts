import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { InternalCallError } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { ApplicantCountProvider } from './applicant-count.provider';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

const application = {
  baseUrl: 'http://app.test',
  internalToken: 'c'.repeat(32),
};
const promotionOffer = {
  enabled: false,
  application,
  internalToken: 'd'.repeat(32),
  topic: 'application.promotion-offer.requested',
  groupId: 'expo-notification-server.promotion-offer',
};
const withApplication = (overrides: Partial<AppConfig> = {}) =>
  createAppConfig({ promotionOffer, ...overrides });

// 2026-10-19 운영 재현: 참가자 행 8명 중 일행 4명이 취소해 확정은 4명이다.
const summary = (expoId: string) => ({
  expoId,
  confirmedUniqueParticipants: 4,
  cancelledUniqueParticipants: 4,
  waitingParticipants: 2,
  pendingReservations: 0,
  pendingApplicants: 0,
  sessions: [
    { sessionId: 1, confirmedParticipants: 3, cancelledParticipants: 4 },
    { sessionId: 2, confirmedParticipants: 2, cancelledParticipants: 0 },
    { sessionId: 9, confirmedParticipants: 0, cancelledParticipants: 0 },
  ],
});

describe('ApplicantCountProvider', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const provider = new ApplicantCountProvider(withApplication());
  const urls = () => fetchSpy.mock.calls.map(([url]) => url as string);

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('박람회마다 Application 확정·대기 인원과 Expo 회차 이름을 붙인다 (취소 제외)', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = input as string;
      if (url.includes('/internal/expo?page=0'))
        return Promise.resolve(
          json({ content: [{ expoId: 'a', title: 'A' }], hasNext: false }),
        );
      if (url.endsWith('/preregister-sessions'))
        return Promise.resolve(
          json([
            { id: 1, title: '10/31 오전', capacity: 30 },
            { id: 2, title: '10/31 오후', capacity: 30 },
          ]),
        );
      return Promise.resolve(json(summary('a')));
    });

    await expect(provider.findAll()).resolves.toEqual([
      {
        expoId: 'a',
        title: 'A',
        confirmed: 4,
        waiting: 2,
        sessions: [
          { title: '10/31 오전', confirmed: 3 },
          { title: '10/31 오후', confirmed: 2 },
          { title: '회차 9', confirmed: 0 },
        ],
      },
    ]);
    expect(urls().sort()).toEqual([
      'http://app.test/internal/expos/a/preregistrations/summary',
      'http://expo.test/internal/expo/a/preregister-sessions',
      'http://expo.test/internal/expo?page=0&size=100',
    ]);
    const tokenOf = (suffix: string) => {
      const call = fetchSpy.mock.calls.find(([url]) =>
        (url as string).endsWith(suffix),
      )!;
      return (call[1]!.headers as Record<string, string>)['X-Internal-Token'];
    };
    expect(tokenOf('/summary')).toBe('c'.repeat(32));
    expect(tokenOf('/preregister-sessions')).toBe('b'.repeat(32));
  });

  it('URL 경로에 넣을 수 없는 expoId는 하위 호출 전에 거부한다', async () => {
    fetchSpy.mockResolvedValue(
      json({ content: [{ expoId: '../admin', title: 'X' }], hasNext: false }),
    );

    await expect(provider.findAll()).rejects.toBeInstanceOf(InternalCallError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('Application 응답의 expoId가 요청과 다르면 다른 박람회 인원으로 보고 실패한다', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = input as string;
      if (url.includes('/internal/expo?'))
        return Promise.resolve(
          json({ content: [{ expoId: 'a', title: 'A' }], hasNext: false }),
        );
      if (url.endsWith('/preregister-sessions'))
        return Promise.resolve(json([]));
      return Promise.resolve(json(summary('b')));
    });

    await expect(provider.findAll()).rejects.toBeInstanceOf(InternalCallError);
  });

  it('hasNext가 끝나지 않으면 무한히 돌지 않고 실패한다', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(json({ content: [], hasNext: true })),
    );

    await expect(provider.findAll()).rejects.toThrow('exceeded 10 pages');
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('Application 연결은 promotionOffer, 없으면 promotion 설정을 쓰고 둘 다 없거나 expo가 없으면 미설정이다', () => {
    const configured = (config: AppConfig) =>
      new ApplicantCountProvider(config).isConfigured();

    expect(configured(withApplication())).toBe(true);
    expect(
      configured(
        createAppConfig({
          promotion: { ...promotionOffer, recoveryHold: false },
        }),
      ),
    ).toBe(true);
    expect(configured(createAppConfig())).toBe(false);
    expect(configured(withApplication({ expo: undefined }))).toBe(false);
  });
});
