import { renderTemplate, TemplateVariables } from './kakao-message';
import { SenderType, SmsEvent } from './sms-event.schema';

// 알림톡 템플릿 본문이자 문자 본문이다. 카카오 승인 본문과 글자 하나까지 같아야 한다.
// 바꾸면 카카오 템플릿도 다시 신청해야 한다.
// K1은 이미 승인된 템플릿(KA01TP26101108020717547GCB2BBgJ6)이라 행사명이 고정이고, "5분"은 sms.authCodeTtlSeconds 기본값과 맞춘다.
export const AUTH_CODE_TEMPLATE =
  '[AI교육원] 2026 AI 미래교육 박람회(AI·SW체험한마당) 신청 인증번호 #{인증번호}입니다. (5분 이내 입력)';
export const QR_REGISTERED_TEMPLATE = [
  '#{행사명} 등록이 완료되었습니다.',
  '입장할 때 아래 QR 링크를 입구에서 보여 주세요.',
  '',
  '▶ 신청 확인(QR확인): #{URL}',
  '',
  '※ 본 메시지는 2026 AI미래교육박람회 신청자에게 발송되었습니다.',
].join('\n');
export const PROMOTION_TEMPLATE = [
  '[#{행사명}] 프로그램 참가 확정 안내',
  '',
  '#{이름}님, 대기 신청하신 프로그램의 참가가 확정되었습니다.',
  '',
  '프로그램: #{프로그램}',
  '일시: #{일시}',
  '장소: #{장소}',
  '',
  '▶ 행사 안내: https://www.hiaisw.kr',
  '▶ 신청 확인·취소: #{URL}',
  '',
  '※ 본 메시지는 2026 AI미래교육박람회 프로그램 참가 확정자에게 발송되었습니다.',
].join('\n');
export const DRAW_RESULT_TEMPLATE = [
  '[#{행사명}] 행운의 숫자 당첨 안내',
  '',
  '축하합니다! 🎉',
  "설문조사 이벤트 '행운의 숫자'에 당첨되셨습니다.",
  '',
  '▶ 당첨 번호: #{번호}번',
  '▶ 경품 수령 장소: #{장소}',
  '',
  '※ 본 메시지는 #{행사명} 설문 참여자 중 당첨자에게 발송되었습니다.',
].join('\n');

export interface TemplateMessage {
  text: string;
  variables: TemplateVariables;
}

const fromTemplate = (
  content: string,
  variables: TemplateVariables,
): TemplateMessage => ({ text: renderTemplate(content, variables), variables });

export interface RenderedSms {
  to: string[];
  senderType: SenderType;
  text: string;
  /** 승인 템플릿 문구로 만든 메시지만 갖는다. 없으면 문자로만 보낸다. */
  variables?: TemplateVariables;
}

export function renderSms(
  event: SmsEvent,
  draw: { expoName: string; prizePlace: string },
): RenderedSms {
  switch (event.type) {
    case 'DRAW_RESULT':
      return {
        to: [event.phoneNumber],
        senderType: 'STANDARD',
        ...fromTemplate(DRAW_RESULT_TEMPLATE, {
          '#{행사명}': draw.expoName,
          '#{번호}': String(event.drawNumber),
          '#{장소}': draw.prizePlace,
        }),
      };
    case 'CUSTOM':
      return {
        to: event.phoneNumbers,
        senderType: event.senderType,
        text: event.text,
      };
  }
}

export function renderAuthCodeSms(code: string): TemplateMessage {
  return fromTemplate(AUTH_CODE_TEMPLATE, { '#{인증번호}': code });
}

export function renderQrSms(params: {
  expoName: string;
  links: readonly { readonly label: string; readonly url: string }[];
}): TemplateMessage {
  const [only] = params.links;
  return fromTemplate(QR_REGISTERED_TEMPLATE, {
    '#{행사명}': params.expoName,
    // 링크가 하나면 URL만, 동행자가 있으면 다음 줄부터 "이름: URL" 줄들을 넣는다.
    '#{URL}':
      params.links.length === 1
        ? only.url
        : params.links.map(({ label, url }) => `\n${label}: ${url}`).join(''),
  });
}
