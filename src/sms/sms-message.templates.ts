import { renderTemplate, TemplateVariables } from './kakao-message';
import { SenderType, SmsEvent } from './sms-event.schema';

// 알림톡 템플릿 본문이자 문자 본문이다. docs/kakao-alimtalk-setup.md K1~K4와 글자 하나까지 같아야 한다.
// 바꾸면 카카오 템플릿도 다시 신청해야 한다.
export const AUTH_CODE_TEMPLATE =
  '[#{행사명}] 인증번호 [#{인증번호}]를 3분 안에 입력해 주세요.';
export const QR_REGISTERED_TEMPLATE = [
  '#{행사명} 등록이 완료되었습니다.',
  '입장할 때 아래 QR 링크를 입구에서 보여 주세요.',
  '',
  '#{QR링크}',
  '(문의) ☎#{문의번호}',
].join('\n');
export const PROMOTION_TEMPLATE = [
  '[#{행사명}] 프로그램 대기 승급 안내',
  '#{이름}님의 프로그램 신청이 확정되었습니다.',
  '프로그램: #{프로그램}',
  '일시: #{일시}',
  '장소: #{장소}',
  '신청 조회: #{신청조회}',
].join('\n');
export const DRAW_RESULT_TEMPLATE =
  '축 당첨! 설문조사 행운의 숫자에 당첨되셨습니다. 선물은 입구 운영본부에서 받아가세요!\n#{번호}번!';

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

export function renderSms(event: SmsEvent): RenderedSms {
  switch (event.type) {
    case 'DRAW_RESULT':
      return {
        to: [event.phoneNumber],
        senderType: 'STANDARD',
        ...fromTemplate(DRAW_RESULT_TEMPLATE, {
          '#{번호}': String(event.drawNumber),
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

export function renderAuthCodeSms(
  expoName: string,
  code: string,
): TemplateMessage {
  return fromTemplate(AUTH_CODE_TEMPLATE, {
    '#{행사명}': expoName,
    '#{인증번호}': code,
  });
}

export function renderQrSms(params: {
  expoName: string;
  links: readonly { readonly label: string; readonly url: string }[];
  contactNumber: string;
}): TemplateMessage {
  return fromTemplate(QR_REGISTERED_TEMPLATE, {
    '#{행사명}': params.expoName,
    '#{QR링크}': params.links
      .map(({ label, url }) => `${label}: ${url}`)
      .join('\n'),
    '#{문의번호}': params.contactNumber,
  });
}
