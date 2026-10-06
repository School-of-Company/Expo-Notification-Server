import { SmsEvent } from './sms-event.schema';
import { renderSms } from './sms-message.templates';

const base = { eventId: 'e1', version: 1 as const };

describe('renderSms', () => {
  it('QR_ISSUED는 QR 링크와 문의 번호를 담는다', () => {
    const rendered = renderSms({
      ...base,
      type: 'QR_ISSUED',
      phoneNumber: '01012345678',
      senderType: 'STANDARD',
      expoName: '광주 박람회',
      qrUrl: 'https://s3.example/qr.jpg',
      contactNumber: '062-380-4504',
    });

    expect(rendered).toEqual({
      to: ['01012345678'],
      senderType: 'STANDARD',
      text: '광주 박람회 현장 등록이 완료되었습니다.\n출입 QR코드 링크: https://s3.example/qr.jpg\n(문의) ☎062-380-4504',
    });
  });

  it('QR_ISSUED는 contactNumber가 없으면 문의 줄을 뺀다', () => {
    const { text } = renderSms({
      ...base,
      type: 'QR_ISSUED',
      phoneNumber: '01012345678',
      senderType: 'TRAINEE',
      expoName: '광주 박람회',
      qrUrl: 'https://s3.example/qr.jpg',
    });

    expect(text).not.toContain('문의');
  });

  it('SURVEY_REQUESTED는 연수생과 일반 참가자 문구가 다르다', () => {
    const event = (senderType: 'STANDARD' | 'TRAINEE'): SmsEvent => ({
      ...base,
      type: 'SURVEY_REQUESTED',
      phoneNumber: '01012345678',
      senderType,
      expoName: '광주 박람회',
      surveyUrl: 'https://survey.example/1',
    });

    expect(renderSms(event('TRAINEE')).text).toContain('퇴장 문자');
    expect(renderSms(event('STANDARD')).text).toContain('광주 박람회 설문조사');
    expect(renderSms(event('STANDARD')).text).toContain(
      'https://survey.example/1',
    );
  });

  it('DRAW_RESULT는 항상 일반 참가자 발신번호를 쓰고 번호를 포함한다', () => {
    const rendered = renderSms({
      ...base,
      type: 'DRAW_RESULT',
      phoneNumber: '01012345678',
      drawNumber: 7,
    });

    expect(rendered.senderType).toBe('STANDARD');
    expect(rendered.text).toContain('7번!');
  });

  it('CUSTOM은 수신자 전체와 본문을 그대로 넘긴다', () => {
    expect(
      renderSms({
        ...base,
        type: 'CUSTOM',
        phoneNumbers: ['01011112222', '01033334444'],
        senderType: 'TRAINEE',
        text: '공지',
      }),
    ).toEqual({
      to: ['01011112222', '01033334444'],
      senderType: 'TRAINEE',
      text: '공지',
    });
  });
});
