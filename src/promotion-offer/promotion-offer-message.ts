import type { PromotionOfferCheck } from './promotion-offer.schema';

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// The shown deadline uses the attempt time, so it is never later than the real one (provider acceptance + hours).
export function promotionOfferDeadline(
  check: Extract<PromotionOfferCheck, { eligible: true }>,
  attemptedAt: Date,
): Date {
  return new Date(
    Math.min(
      attemptedAt.getTime() + check.responseHours * 3_600_000,
      Date.parse(check.hardDeadline),
    ),
  );
}

export function promotionOfferMessage(
  expoName: string,
  check: Extract<PromotionOfferCheck, { eligible: true }>,
  attemptedAt: Date,
): string {
  return [
    `[${expoName}] 대기 참여 제안 안내`,
    `${check.recipientName}님, 대기 중인 신청에 자리가 생겼습니다.`,
    `${check.target === 'PROGRAM' ? '프로그램' : '회차'}: ${check.title}`,
    `일시: ${dateTime.format(new Date(check.startedAt))} ~ ${dateTime.format(new Date(check.endedAt))} (한국시간)`,
    ...(check.location ? [`장소: ${check.location}`] : []),
    `확보 인원: ${check.seats}명`,
    `응답 기한: ${dateTime.format(promotionOfferDeadline(check, attemptedAt))} (한국시간)`,
    '기한 안에 아래에서 수락해야 신청이 확정됩니다. 거절하거나 기한이 지나면 대기가 종료됩니다.',
    `응답하기: ${check.responseUrl}`,
  ].join('\n');
}
