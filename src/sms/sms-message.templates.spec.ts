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
const draw = { expoName: '광주 박람회', prizePlace: '입구 운영본부' };

// 솔라피 승인 본문(K1, #100의 K2~K4). 승인된 글자와 달라지면 알림톡 발송이 실패한다.
describe('알림톡 템플릿 상수', () => {
  it('K1~K4 승인 본문과 글자 그대로 같다', () => {
    expect(AUTH_CODE_TEMPLATE).toBe(
      '[AI교육원] 2026 AI 미래교육 박람회(AI·SW체험한마당) 신청 인증번호 #{인증번호}입니다. (5분 이내 입력)',
    );
    expect(QR_REGISTERED_TEMPLATE).toBe(`#{행사명} 등록이 완료되었습니다.
입장할 때 아래 QR 링크를 입구에서 보여 주세요.

▶ 신청 확인(QR확인): #{URL}

※ 본 메시지는 2026 AI미래교육박람회 신청자에게 발송되었습니다.`);
    expect(PROMOTION_TEMPLATE).toBe(`[#{행사명}] 프로그램 참가 확정 안내

#{이름}님, 대기 신청하신 프로그램의 참가가 확정되었습니다.

프로그램: #{프로그램}
일시: #{일시}
장소: #{장소}

▶ 행사 안내: https://www.hiaisw.kr
▶ 신청 확인·취소: #{URL}

※ 본 메시지는 2026 AI미래교육박람회 프로그램 참가 확정자에게 발송되었습니다.`);
    expect(DRAW_RESULT_TEMPLATE).toBe(`[#{행사명}] 행운의 숫자 당첨 안내

축하합니다! 🎉
설문조사 이벤트 '행운의 숫자'에 당첨되셨습니다.

▶ 당첨 번호: #{번호}번
▶ 경품 수령 장소: #{장소}

※ 본 메시지는 #{행사명} 설문 참여자 중 당첨자에게 발송되었습니다.`);
  });
});

describe('renderSms', () => {
  it('DRAW_RESULT는 일반 참가자 발신번호와 K4 문구, 알림톡 변수를 돌려준다', () => {
    expect(
      renderSms(
        {
          ...base,
          type: 'DRAW_RESULT',
          phoneNumber: '01012345678',
          drawNumber: 7,
        },
        draw,
      ),
    ).toEqual({
      to: ['01012345678'],
      senderType: 'STANDARD',
      text: `[광주 박람회] 행운의 숫자 당첨 안내

축하합니다! 🎉
설문조사 이벤트 '행운의 숫자'에 당첨되셨습니다.

▶ 당첨 번호: 7번
▶ 경품 수령 장소: 입구 운영본부

※ 본 메시지는 광주 박람회 설문 참여자 중 당첨자에게 발송되었습니다.`,
      variables: {
        '#{행사명}': '광주 박람회',
        '#{번호}': '7',
        '#{장소}': '입구 운영본부',
      },
    });
  });

  it('CUSTOM은 수신자 전체와 본문을 그대로 넘기고 알림톡 변수가 없다', () => {
    expect(
      renderSms(
        {
          ...base,
          type: 'CUSTOM',
          phoneNumbers: ['01011112222', '01033334444'],
          senderType: 'TRAINEE',
          text: '공지',
        },
        draw,
      ),
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
  const header =
    '광주 박람회 등록이 완료되었습니다.\n입장할 때 아래 QR 링크를 입구에서 보여 주세요.\n\n▶ 신청 확인(QR확인): ';
  const footer =
    '\n\n※ 본 메시지는 2026 AI미래교육박람회 신청자에게 발송되었습니다.';

  it('링크가 하나면 #{URL}에 URL만 넣는다', () => {
    expect(
      renderQrSms({
        expoName: '광주 박람회',
        links: [{ label: '홍길동(대표자)', url: 'https://expo.test/qr?id=1' }],
      }),
    ).toEqual({
      text: `${header}https://expo.test/qr?id=1${footer}`,
      variables: {
        '#{행사명}': '광주 박람회',
        '#{URL}': 'https://expo.test/qr?id=1',
      },
    });
  });

  it('동행자가 있으면 #{URL}에 줄바꿈 뒤 "이름: URL" 줄들을 넣는다', () => {
    const links =
      '\n홍길동(대표자): https://expo.test/qr?id=1\n동행자 1: https://expo.test/qr?id=2';
    expect(
      renderQrSms({
        expoName: '광주 박람회',
        links: [
          { label: '홍길동(대표자)', url: 'https://expo.test/qr?id=1' },
          { label: '동행자 1', url: 'https://expo.test/qr?id=2' },
        ],
      }),
    ).toEqual({
      text: `${header}${links}${footer}`,
      variables: { '#{행사명}': '광주 박람회', '#{URL}': links },
    });
  });
});
