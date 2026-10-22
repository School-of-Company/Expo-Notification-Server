import { renderTemplate, TemplateVariables } from './kakao-message';
import type { ApplicationResultEvent } from './application-result.schema';
import type { TemplateMessage } from './sms-message.templates';

// 카카오 전환 전 내부 문구·변수 계약이다. 승인된 알림톡 템플릿이 아니라서 문자로만 보낸다(variables는 계약 확인용).
// 변수: #{행사명} #{안내문구} #{신청내역} #{URL}
const body = (title: string): string =>
  [
    `[#{행사명}] ${title}`,
    '',
    '#{안내문구}',
    '',
    '#{신청내역}',
    '',
    '▶ 신청 확인: #{URL}',
  ].join('\n');

export const PROGRAM_CONFIRMED_TEMPLATE = body('프로그램 신청 확정 안내');
export const PROGRAM_WAITLISTED_TEMPLATE = body('프로그램 대기 접수 안내');
export const PROGRAM_CANCELLED_TEMPLATE = body('프로그램 신청 취소 안내');
export const PREREGISTER_CANCELLED_TEMPLATE = body('사전등록 취소 안내');
export const PREREGISTER_SESSION_ADDED_TEMPLATE =
  body('사전등록 회차 추가 결과 안내');
export const OFFER_EXPIRED_TEMPLATE = body('참여 의사 확인 기한 만료 안내');

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

type Item = ApplicationResultEvent['items'][number];

const RESULT_LABEL = {
  CONFIRMED: '확정',
  WAITLISTED: '대기 (아직 확정되지 않음)',
} as const;

function itemBlock(item: Item): string {
  const lines = [`■ ${item.participantName}`, `${item.title}`];
  if (item.startedAt && item.endedAt) {
    lines.push(
      `일시: ${dateTime.format(new Date(item.startedAt))} ~ ${dateTime.format(new Date(item.endedAt))} (한국시간)`,
    );
  }
  if (item.location) lines.push(`장소: ${item.location}`);
  if ('result' in item) lines.push(`상태: ${RESULT_LABEL[item.result]}`);
  return lines.join('\n');
}

function cancelledLead(
  subject: string,
  cancelledBy: 'USER' | 'ADMIN',
  partialNote: string,
): string {
  const who = cancelledBy === 'ADMIN' ? '관리자에 의해 ' : '';
  return `${who}아래 ${subject}이(가) 취소되었습니다. ${partialNote}`;
}

function lead(event: ApplicationResultEvent): string {
  switch (event.type) {
    case 'PROGRAM_CONFIRMED':
      return '신청이 확정되었습니다.';
    case 'PROGRAM_WAITLISTED':
      return '대기로 접수되었습니다. 아직 참가가 확정된 것이 아니며, 자리가 나면 별도로 안내드립니다.';
    case 'PROGRAM_CANCELLED':
      return cancelledLead(
        '신청',
        event.cancelledBy,
        '목록에 없는 신청은 취소되지 않았습니다.',
      );
    case 'PREREGISTER_CANCELLED':
      return event.scope === 'ALL'
        ? cancelledLead('사전등록', event.cancelledBy, '')
        : cancelledLead(
            '사전등록',
            event.cancelledBy,
            '목록에 없는 등록은 그대로 유지됩니다.',
          );
    case 'PREREGISTER_SESSION_ADDED':
      return '요청하신 회차 추가 결과입니다. 상태가 대기인 회차는 아직 확정되지 않았습니다.';
    case 'OFFER_EXPIRED':
      return '참여 의사 확인 기한이 지나 대기 참여 제안이 만료되었습니다. 아래 신청은 확정되지 않았습니다.';
  }
}

const TEMPLATES: Record<ApplicationResultEvent['type'], string> = {
  PROGRAM_CONFIRMED: PROGRAM_CONFIRMED_TEMPLATE,
  PROGRAM_WAITLISTED: PROGRAM_WAITLISTED_TEMPLATE,
  PROGRAM_CANCELLED: PROGRAM_CANCELLED_TEMPLATE,
  PREREGISTER_CANCELLED: PREREGISTER_CANCELLED_TEMPLATE,
  PREREGISTER_SESSION_ADDED: PREREGISTER_SESSION_ADDED_TEMPLATE,
  OFFER_EXPIRED: OFFER_EXPIRED_TEMPLATE,
};

export function renderApplicationResult(
  event: ApplicationResultEvent,
  expoName: string,
): TemplateMessage {
  const variables: TemplateVariables = {
    '#{행사명}': expoName,
    '#{안내문구}': lead(event).trim(),
    '#{신청내역}': (event.items as Item[]).map(itemBlock).join('\n\n'),
    '#{URL}': event.applicationUrl ?? '신청시스템에서 확인해 주세요',
  };
  return {
    text: renderTemplate(TEMPLATES[event.type], variables),
    variables,
  };
}
