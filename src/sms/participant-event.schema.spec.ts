import {
  entryRecordedSchema,
  participantRegisteredSchema,
} from './participant-event.schema';

const valid = {
  eventId: 'e1',
  expoId: 'expo-1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '010-1234-5678',
};

describe('participantRegisteredSchema', () => {
  it('하이픈이 있는 번호를 숫자만 남겨 정규화한다', () => {
    const result = participantRegisteredSchema.parse(valid);

    expect(result.phoneNumber).toBe('01012345678');
  });

  it('연수자(TRAINEE)도 받는다', () => {
    expect(
      participantRegisteredSchema.safeParse({
        ...valid,
        participationType: 'TRAINEE',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['eventId 누락', { ...valid, eventId: undefined }],
    ['알 수 없는 participationType', { ...valid, participationType: 'ADMIN' }],
    ['id가 숫자가 아님', { ...valid, id: '42' }],
    ['전화번호 형식 오류', { ...valid, phoneNumber: '1234' }],
    ['0 ID', { ...valid, id: 0 }],
    ['unsafe ID', { ...valid, id: Number.MAX_SAFE_INTEGER + 1 }],
    ['빈 목록', { ...valid, participants: [] }],
    [
      '6명',
      {
        ...valid,
        participants: Array.from({ length: 6 }, (_, i) => ({
          id: i + 1,
          code: 'a'.repeat(22),
        })),
      },
    ],
    [
      '중복 ID',
      {
        ...valid,
        participants: [
          { id: 1, code: 'a'.repeat(22) },
          { id: 1, code: 'b'.repeat(22) },
        ],
      },
    ],
    [
      '잘못된 code 길이',
      { ...valid, participants: [{ id: 1, code: 'a'.repeat(21) }] },
    ],
    [
      'code 주입',
      { ...valid, participants: [{ id: 1, code: '&'.repeat(22) }] },
    ],
    [
      'unsafe 참가자 ID',
      {
        ...valid,
        participants: [
          { id: Number.MAX_SAFE_INTEGER + 1, code: 'a'.repeat(22) },
        ],
      },
    ],
  ])('%s는 거부한다', (_name, payload) => {
    expect(participantRegisteredSchema.safeParse(payload).success).toBe(false);
  });

  it('participants/code 누락은 서비스에서 구버전 미지원으로 처리하도록 보존한다', () => {
    expect(
      participantRegisteredSchema.parse({
        ...valid,
        participants: [{ id: 42 }],
      }).participants,
    ).toEqual([{ id: 42 }]);
    expect(
      participantRegisteredSchema.parse(valid).participants,
    ).toBeUndefined();
  });

  it('이름은 이벤트에서 사용하지 않고 User API로만 조회한다', () => {
    expect(
      participantRegisteredSchema.parse({
        ...valid,
        representativeId: 42,
        participants: [{ id: 42, code: 'a'.repeat(22), name: 'Kafka이름' }],
      }).participants,
    ).toEqual([{ id: 42, code: 'a'.repeat(22) }]);
  });
});

describe('entryRecordedSchema', () => {
  it('같은 형태의 입장 이벤트를 받는다', () => {
    expect(entryRecordedSchema.safeParse(valid).success).toBe(true);
  });
});
