import {
  renderQrSms,
  renderSms,
  renderSurveySms,
} from './sms-message.templates';

const base = { eventId: 'e1', version: 1 as const };

describe('renderSms', () => {
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

describe('renderQrSms', () => {
  it('행사명, QR 링크, 문의 번호를 담는다', () => {
    expect(
      renderQrSms({
        expoName: '광주 박람회',
        qrUrl: 'https://s3.example/qr.jpg',
        contactNumber: '062-380-4504',
      }),
    ).toBe(
      '광주 박람회 현장 등록이 완료되었습니다.\n출입 QR코드 링크: https://s3.example/qr.jpg\n(문의) ☎062-380-4504',
    );
  });

  it('문의 번호가 없으면 문의 줄을 뺀다', () => {
    expect(
      renderQrSms({ expoName: '박람회', qrUrl: 'https://s3.example/qr.jpg' }),
    ).not.toContain('문의');
  });
});

describe('renderSurveySms', () => {
  it('행사명과 설문 링크를 담는다', () => {
    const text = renderSurveySms({
      expoName: '광주 박람회',
      surveyUrl: 'https://survey.example/1',
    });

    expect(text).toContain('광주 박람회 설문조사');
    expect(text).toContain('https://survey.example/1');
  });
});
