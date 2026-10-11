import type { PromotionCheck } from './promotion.schema';

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function promotionMessage(
  expoName: string,
  check: Extract<PromotionCheck, { eligible: true }>,
): string {
  return [
    `[${expoName}] 프로그램 대기 승급 안내`,
    `${check.participantName}님의 프로그램 신청이 확정되었습니다.`,
    `프로그램: ${check.programName}`,
    `일시: ${dateTime.format(new Date(check.startedAt))} ~ ${dateTime.format(new Date(check.endedAt))} (한국시간)`,
    ...(check.location ? [`장소: ${check.location}`] : []),
    ...(check.applicationLookupUrl
      ? [`신청 조회: ${check.applicationLookupUrl}`]
      : []),
  ].join('\n');
}
