import { formatPeriod, renderQrSmsWithNotices } from './qr-notice-message';
import { renderQrSms } from './sms-message.templates';
import type { ParticipantNotice } from './participant-notice.provider';

const session = {
  title: '10월 31일 오전 회차',
  startedAt: '2026-10-31T10:00:00+09:00',
  endedAt: '2026-10-31T12:00:00+09:00',
  place: '1관',
};
const program = {
  title: '로봇 체험',
  startedAt: '2026-10-31T10:30:00+09:00',
  endedAt: '2026-10-31T11:00:00+09:00',
  location: '체험존 A',
};

const build = (
  links: { label: string; url: string }[],
  notices: Map<number, ParticipantNotice>,
) => {
  const { text } = renderQrSms({ expoName: '광주 박람회', links });
  return renderQrSmsWithNotices({
    linkOnlyText: text,
    expoName: '광주 박람회',
    links,
    linkIds: links.map((_, index) => 42 + index),
    notices,
  });
};

describe('formatPeriod', () => {
  it('같은 날이면 날짜를 한 번만 쓰고 한국 시간으로 보여 준다', () => {
    expect(formatPeriod('2026-10-31T01:00:00Z', '2026-10-31T03:00:00Z')).toBe(
      '10/31 10:00~12:00',
    );
  });

  it('날짜가 다르면 끝에도 날짜를 붙인다', () => {
    expect(
      formatPeriod('2026-10-31T10:00:00+09:00', '2026-11-01T09:00:00+09:00'),
    ).toBe('10/31 10:00~11/1 09:00');
  });

  it('시각이 없으면 빈 문자열이다', () => {
    expect(formatPeriod(undefined, undefined)).toBe('');
  });
});

describe('renderQrSmsWithNotices', () => {
  const link = { label: '홍길동(대표자)', url: 'https://expo.test/qr?id=42' };

  it('신청 내역이 없으면 링크만 보내는 본문 그대로다', () => {
    const { text } = renderQrSms({ expoName: '광주 박람회', links: [link] });
    expect(build([link], new Map())).toBe(text);
  });

  it('링크가 하나면 링크 뒤에 회차와 프로그램 줄을 넣고 안내 문구는 뒤에 둔다', () => {
    const text = build(
      [link],
      new Map([[42, { sessions: [session], programs: [program] }]]),
    );
    expect(text).toBe(
      [
        '광주 박람회 등록이 완료되었습니다.',
        '입장할 때 아래 QR 링크를 입구에서 보여 주세요.',
        '',
        '▶ 신청 확인(QR확인): https://expo.test/qr?id=42',
        '',
        '▶ 신청 내역',
        '회차: 10월 31일 오전 회차 10/31 10:00~12:00 @1관',
        '프로그램: 로봇 체험 10/31 10:30~11:00 @체험존 A',
        '',
        '※ 본 메시지는 2026 AI미래교육박람회 신청자에게 발송되었습니다.',
      ].join('\n'),
    );
  });

  it('동행자가 있으면 이름 아래에 각자의 내역을 묶고, 내역이 없는 사람은 건너뛴다', () => {
    const text = build(
      [link, { label: '동행자 1', url: 'https://expo.test/qr?id=43' }],
      new Map([[42, { sessions: [session], programs: [] }]]),
    );
    expect(text).toContain(
      '▶ 신청 내역\n■ 홍길동(대표자)\n회차: 10월 31일 오전 회차',
    );
    expect(text).not.toContain('■ 동행자 1');
  });

  it('2,000바이트를 넘으면 프로그램을 빼고 회차만, 그래도 넘으면 링크만 보낸다', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...program,
      title: `프로그램 ${i} ${'가'.repeat(40)}`,
    }));
    const withSessions = build(
      [link],
      new Map([[42, { sessions: [session], programs: many }]]),
    );
    expect(withSessions).toContain('회차: ');
    expect(withSessions).not.toContain('프로그램:');
    expect(Buffer.byteLength(withSessions, 'utf8')).toBeLessThanOrEqual(2000);

    const hugeSession = {
      ...session,
      title: '가'.repeat(100),
      place: '나'.repeat(255),
    };
    const manySessions = Array.from({ length: 10 }, () => hugeSession);
    const { text } = renderQrSms({ expoName: '광주 박람회', links: [link] });
    expect(
      build(
        [link],
        new Map([[42, { sessions: manySessions, programs: many }]]),
      ),
    ).toBe(text);
  });
});
