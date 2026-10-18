import {
  AUTH_CODE_TEMPLATE,
  DRAW_RESULT_TEMPLATE,
  PROMOTION_TEMPLATE,
  QR_REGISTERED_TEMPLATE,
  renderAuthCodeSms,
  renderQrSms,
  renderSms,
} from './sms-message.templates';

const base = { eventId: 'e1', version: 1 as const };

// docs/kakao-alimtalk-setup.md K1~K4 본문. 카카오에 신청한 글자와 달라지면 알림톡 발송이 실패한다.
describe('알림톡 템플릿 상수', () => {
  it('K1~K4 승인 신청 본문과 글자 그대로 같다', () => {
    expect(AUTH_CODE_TEMPLATE).toBe(
      '[AI교육원] 2026 AI 미래교육 박람회(AI·SW체험한마당) 신청 인증번호 #{인증번호}입니다. (5분 이내 입력)',
    );
    expect(QR_REGISTERED_TEMPLATE).toBe(
      '#{행사명} 등록이 완료되었습니다.\n입장할 때 아래 QR 링크를 입구에서 보여 주세요.\n\n#{QR링크}\n(문의) ☎#{문의번호}',
    );
    expect(PROMOTION_TEMPLATE).toBe(
      '[#{행사명}] 프로그램 대기 승급 안내\n#{이름}님의 프로그램 신청이 확정되었습니다.\n프로그램: #{프로그램}\n일시: #{일시}\n장소: #{장소}\n신청 조회: #{신청조회}',
    );
    expect(DRAW_RESULT_TEMPLATE).toBe(
      '축 당첨! 설문조사 행운의 숫자에 당첨되셨습니다. 선물은 입구 운영본부에서 받아가세요!\n#{번호}번!',
    );
  });
});

describe('renderSms', () => {
  it('DRAW_RESULT는 일반 참가자 발신번호와 K4 문구, 알림톡 변수를 돌려준다', () => {
    expect(
      renderSms({
        ...base,
        type: 'DRAW_RESULT',
        phoneNumber: '01012345678',
        drawNumber: 7,
      }),
    ).toEqual({
      to: ['01012345678'],
      senderType: 'STANDARD',
      text: '축 당첨! 설문조사 행운의 숫자에 당첨되셨습니다. 선물은 입구 운영본부에서 받아가세요!\n7번!',
      variables: { '#{번호}': '7' },
    });
  });

  it('CUSTOM은 수신자 전체와 본문을 그대로 넘기고 알림톡 변수가 없다', () => {
    expect(
      renderSms({
        ...base,
        type: 'CUSTOM',
        phoneNumbers: ['01011112222', '01033334444'],
        senderType: 'TRAINEE',
        text: '공지',
      }),
    ).toStrictEqual({
      to: ['01011112222', '01033334444'],
      senderType: 'TRAINEE',
      text: '공지',
    });
  });
});

describe('renderAuthCodeSms', () => {
  it('인증번호를 승인된 K1 문구에 넣는다', () => {
    expect(renderAuthCodeSms('0123')).toEqual({
      text: '[AI교육원] 2026 AI 미래교육 박람회(AI·SW체험한마당) 신청 인증번호 0123입니다. (5분 이내 입력)',
      variables: { '#{인증번호}': '0123' },
    });
  });
});

describe('renderQrSms', () => {
  it('행사명, QR 링크 줄, 문의 번호를 K2 문구에 넣는다', () => {
    expect(
      renderQrSms({
        expoName: '광주 박람회',
        links: [
          { label: '홍길동(대표자)', url: 'https://expo.test/qr?id=1' },
          { label: '동행자 1', url: 'https://expo.test/qr?id=2' },
        ],
        contactNumber: '062-380-4504',
      }),
    ).toEqual({
      text: '광주 박람회 등록이 완료되었습니다.\n입장할 때 아래 QR 링크를 입구에서 보여 주세요.\n\n홍길동(대표자): https://expo.test/qr?id=1\n동행자 1: https://expo.test/qr?id=2\n(문의) ☎062-380-4504',
      variables: {
        '#{행사명}': '광주 박람회',
        '#{QR링크}':
          '홍길동(대표자): https://expo.test/qr?id=1\n동행자 1: https://expo.test/qr?id=2',
        '#{문의번호}': '062-380-4504',
      },
    });
  });
});
