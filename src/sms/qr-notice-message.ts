import type {
  NoticeProgram,
  NoticeSession,
  ParticipantNotice,
} from './participant-notice.provider';

// 문자 본문이다. 알림톡은 승인 본문(QR_REGISTERED_TEMPLATE)을 그대로 쓰고 이 본문은 쓰지 않는다. 알림톡 재승인 뒤 함께 바꾼다(#136).
const SMS_LIMIT_BYTES = 2_000;

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(value: string): { date: string; time: string } {
  const map = Object.fromEntries(
    dayFormat.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${Number(map.month)}/${Number(map.day)}`,
    time: `${map.hour}:${map.minute}`,
  };
}

/** `10/31 10:00~11:00`. 날짜가 다르면 끝에도 날짜를 붙인다. 시각이 없으면 빈 문자열. */
export function formatPeriod(startedAt?: string, endedAt?: string): string {
  if (!startedAt || !endedAt) return '';
  const start = parts(startedAt);
  const end = parts(endedAt);
  return start.date === end.date
    ? `${start.date} ${start.time}~${end.time}`
    : `${start.date} ${start.time}~${end.date} ${end.time}`;
}

const line = (
  prefix: string,
  title: string,
  period: string,
  place?: string | null,
): string =>
  [`${prefix}: ${title}`, period, place ? `@${place}` : '']
    .filter(Boolean)
    .join(' ');

const sessionLine = (s: NoticeSession) =>
  line('회차', s.title, formatPeriod(s.startedAt, s.endedAt), s.place);
const programLine = (p: NoticeProgram) =>
  line('프로그램', p.title, formatPeriod(p.startedAt, p.endedAt), p.location);

function detailBlock(
  links: readonly { label: string; url: string }[],
  notices: ReadonlyMap<number, ParticipantNotice>,
  ids: readonly number[],
  withPrograms: boolean,
): string {
  const blocks = links.flatMap(({ label }, index) => {
    const notice = notices.get(ids[index]);
    if (!notice) return [];
    const lines = [
      ...notice.sessions.map(sessionLine),
      ...(withPrograms ? notice.programs.map(programLine) : []),
    ];
    if (lines.length === 0) return [];
    return [
      links.length === 1
        ? lines.join('\n')
        : [`■ ${label}`, ...lines].join('\n'),
    ];
  });
  return blocks.join('\n\n');
}

/**
 * 링크만 보내는 승인 본문 문자에 회차·프로그램 줄을 더한 문자 본문을 만든다. 2,000바이트(LMS)를 넘으면 프로그램을 빼고 회차만,
 * 그래도 넘으면 링크만 보낸다. [linkOnlyText]는 승인 본문으로 만든 기존 문자 본문이다.
 */
export function renderQrSmsWithNotices(params: {
  linkOnlyText: string;
  expoName: string;
  links: readonly { label: string; url: string }[];
  linkIds: readonly number[];
  notices: ReadonlyMap<number, ParticipantNotice>;
}): string {
  if (params.notices.size === 0) return params.linkOnlyText;
  const footerIndex = params.linkOnlyText.lastIndexOf('\n\n※');
  if (footerIndex < 0) return params.linkOnlyText;
  const head = params.linkOnlyText.slice(0, footerIndex);
  const footer = params.linkOnlyText.slice(footerIndex);
  for (const withPrograms of [true, false]) {
    const detail = detailBlock(
      params.links,
      params.notices,
      params.linkIds,
      withPrograms,
    );
    if (!detail) continue;
    const text = `${head}\n\n▶ 신청 내역\n${detail}${footer}`;
    if (Buffer.byteLength(text, 'utf8') <= SMS_LIMIT_BYTES) return text;
  }
  return params.linkOnlyText;
}
