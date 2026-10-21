import {
  PROMOTION_TEMPLATE,
  type TemplateMessage,
} from '../sms/sms-message.templates';
import { renderTemplate } from '../sms/kakao-message';
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

// 알림톡 템플릿은 줄을 뺄 수 없어 값이 없으면 안내 문구를 넣는다.
export function promotionMessage(
  expoName: string,
  check: Extract<PromotionCheck, { eligible: true }>,
): TemplateMessage {
  const variables = {
    '#{행사명}': expoName,
    '#{이름}': check.participantName,
    '#{프로그램}': check.programName,
    '#{일시}': `${dateTime.format(new Date(check.startedAt))} ~ ${dateTime.format(new Date(check.endedAt))} (한국시간)`,
    '#{장소}': check.location ?? '추후 안내',
    '#{URL}': check.applicationLookupUrl ?? '신청시스템에서 확인해 주세요',
  };
  return { text: renderTemplate(PROMOTION_TEMPLATE, variables), variables };
}
