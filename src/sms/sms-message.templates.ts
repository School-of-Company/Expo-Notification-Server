import { SenderType, SmsEvent } from './sms-event.schema';

export interface RenderedSms {
  to: string[];
  senderType: SenderType;
  text: string;
}

export function renderSms(event: SmsEvent): RenderedSms {
  switch (event.type) {
    case 'QR_ISSUED': {
      const lines = [
        `${event.expoName} 현장 등록이 완료되었습니다.`,
        `출입 QR코드 링크: ${event.qrUrl}`,
      ];
      if (event.contactNumber) {
        lines.push(`(문의) ☎${event.contactNumber}`);
      }
      return {
        to: [event.phoneNumber],
        senderType: event.senderType,
        text: lines.join('\n'),
      };
    }
    case 'SURVEY_REQUESTED':
      return {
        to: [event.phoneNumber],
        senderType: event.senderType,
        text:
          event.senderType === 'TRAINEE'
            ? `박람회 퇴장 문자입니다.\n박람회 만족도 조사에 참가해주세요.\n${event.surveyUrl}`
            : `${event.expoName} 설문조사\n${event.expoName}을 방문해주셔서 감사합니다. 체험 후 꼭 설문에 응답해주세요.\n${event.surveyUrl}`,
      };
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
