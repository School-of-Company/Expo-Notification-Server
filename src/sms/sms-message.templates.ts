import { SenderType, SmsEvent } from './sms-event.schema';

export interface RenderedSms {
  to: string[];
  senderType: SenderType;
  text: string;
}

export function renderSms(event: SmsEvent): RenderedSms {
  switch (event.type) {
    case 'DRAW_RESULT':
      return {
        to: [event.phoneNumber],
        senderType: 'STANDARD',
        text: `축 당첨! 설문조사 행운의 숫자에 당첨되셨습니다. 선물은 입구 운영본부에서 받아가세요!\n${event.drawNumber}번!`,
      };
    case 'CUSTOM':
      return {
        to: event.phoneNumbers,
        senderType: event.senderType,
        text: event.text,
      };
  }
}

export function renderQrSms(params: {
  expoName: string;
  links: readonly { readonly label: string; readonly url: string }[];
  contactNumber?: string;
}): string {
  const lines = [
    `${params.expoName} 등록이 완료되었습니다.`,
    '입장할 때 아래 QR 링크를 입구에서 보여 주세요.',
    '',
    ...params.links.map(({ label, url }) => `${label}: ${url}`),
  ];
  if (params.contactNumber) {
    lines.push(`(문의) ☎${params.contactNumber}`);
  }
  return lines.join('\n');
}

export function renderSurveySms(params: {
  expoName: string;
  surveyUrl: string;
}): string {
  return `${params.expoName} 설문조사\n${params.expoName}을 방문해주셔서 감사합니다. 체험 후 꼭 설문에 응답해주세요.\n${params.surveyUrl}`;
}
