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
  ])('%s는 거부한다', (_name, payload) => {
    expect(participantRegisteredSchema.safeParse(payload).success).toBe(false);
  });
});

describe('entryRecordedSchema', () => {
  it('같은 형태의 입장 이벤트를 받는다', () => {
    expect(entryRecordedSchema.safeParse(valid).success).toBe(true);
  });
});
