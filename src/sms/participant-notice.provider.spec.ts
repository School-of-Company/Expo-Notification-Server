import { Logger } from '@nestjs/common';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import type { AppConfig } from '../config/app-config';
import { ParticipantNoticeProvider } from './participant-notice.provider';

const application = {
  baseUrl: 'http://application.test',
  internalToken: 'b'.repeat(32),
};
const body = [
  {
    participantId: 42,
    sessions: [
      {
        title: '10월 31일 오전',
        startedAt: '2026-10-31T10:00:00+09:00',
        endedAt: '2026-10-31T12:00:00+09:00',
        place: '1관',
      },
    ],
    programs: [{ programType: 'STANDARD', title: '로봇 체험' }],
  },
  { participantId: 43, sessions: [], programs: [] },
];

describe('ParticipantNoticeProvider', () => {
  const request = { expoId: 'expo-1', participantIds: [42, 43] };
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const provider = (enabled: boolean, connected = true) => {
    const config: AppConfig = createAppConfig();
    config.sms = { ...config.sms, qrNotice: { enabled } };
    if (connected) {
      config.promotion = { application } as unknown as AppConfig['promotion'];
    }
    return new ParticipantNoticeProvider(config);
  };
  afterEach(() => jest.clearAllMocks());
  afterAll(() => jest.restoreAllMocks());

  it('요청 순서대로 확정 회차와 프로그램을 받아 토큰 헤더로 조회한다', async () => {
    fetchSpy.mockResolvedValue(Response.json(body));

    const notices = await provider(true).findNotices(request);

    expect(notices.get(42)?.sessions[0]?.title).toBe('10월 31일 오전');
    expect(notices.get(42)?.programs).toHaveLength(1);
    expect(notices.get(43)).toEqual({ sessions: [], programs: [] });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://application.test/internal/expos/expo-1/participants/notice-items',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'b'.repeat(32),
        },
        body: JSON.stringify({ participantIds: [42, 43] }),
      }),
    );
  });

  it('꺼져 있거나 Application 연결이 없으면 호출하지 않고 빈 결과다', async () => {
    expect([...(await provider(false).findNotices(request))]).toEqual([]);
    expect([...(await provider(true, false).findNotices(request))]).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([404, 500, 503])('HTTP %s는 빈 결과로 대체한다', async (status) => {
    fetchSpy.mockResolvedValue(new Response('{}', { status }));
    expect([...(await provider(true).findNotices(request))]).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('네트워크 오류도 원문을 남기지 않고 빈 결과로 대체한다', async () => {
    fetchSpy.mockRejectedValue(new Error('connect 010-1234-5678 failed'));
    expect([...(await provider(true).findNotices(request))]).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('010');
  });

  it.each([
    ['개수가 다르다', [body[0]]],
    ['순서가 다르다', [body[1], body[0]]],
    [
      '제어 문자가 있다',
      [{ ...body[0], sessions: [{ title: 'a\nb' }] }, body[1]],
    ],
    [
      '알 수 없는 프로그램 종류다',
      [{ ...body[0], programs: [{ programType: 'X', title: 'a' }] }, body[1]],
    ],
  ])('응답이 잘못되면(%s) 빈 결과로 대체한다', async (_, invalid) => {
    fetchSpy.mockResolvedValue(Response.json(invalid));
    expect([...(await provider(true).findNotices(request))]).toEqual([]);
  });
});
