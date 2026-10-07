import { smsEventSchema } from './sms-event.schema';

const base = { eventId: 'e1', version: 1 };

describe('smsEventSchema', () => {
  it('DRAW_RESULT를 받는다', () => {
    const result = smsEventSchema.safeParse({
      ...base,
      type: 'DRAW_RESULT',
      phoneNumber: '01012345678',
      drawNumber: 3,
    });

    expect(result.success).toBe(true);
  });

  it('더 이상 지원하지 않는 QR_ISSUED/SURVEY_REQUESTED는 거부한다 (User/Attention 이벤트로 대체)', () => {
    for (const type of ['QR_ISSUED', 'SURVEY_REQUESTED']) {
      expect(smsEventSchema.safeParse({ ...base, type }).success).toBe(false);
    }
  });

  it('CUSTOM은 수신자 1명 이상 1000명 이하만 받는다', () => {
    const custom = (phoneNumbers: string[]) =>
      smsEventSchema.safeParse({
        ...base,
        type: 'CUSTOM',
        phoneNumbers,
        senderType: 'TRAINEE',
        text: '안내',
      });

    expect(custom([]).success).toBe(false);
    expect(
      custom(Array.from({ length: 1001 }, () => '01012345678')).success,
    ).toBe(false);
    expect(custom(['01012345678']).success).toBe(true);
  });

  it.each([
    ['알 수 없는 type', { ...base, type: 'UNKNOWN' }],
    [
      'version 불일치',
      {
        ...base,
        version: 2,
        type: 'DRAW_RESULT',
        phoneNumber: '01012345678',
        drawNumber: 1,
      },
    ],
    [
      '전화번호 형식 오류',
      { ...base, type: 'DRAW_RESULT', phoneNumber: '1234', drawNumber: 1 },
    ],
    [
      'eventId 누락',
      {
        version: 1,
        type: 'DRAW_RESULT',
        phoneNumber: '01012345678',
        drawNumber: 1,
      },
    ],
  ])('%s는 거부한다', (_name, payload) => {
    expect(smsEventSchema.safeParse(payload).success).toBe(false);
  });
});
