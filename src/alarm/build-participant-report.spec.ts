import { buildParticipantReport } from './build-participant-report';

const stat = {
  expoId: 'expo-1',
  title: '광주 박람회',
  applicationPerson: 120,
  yesterdayApplicationPerson: 100,
};

describe('buildParticipantReport', () => {
  it('박람회 이름/어제/오늘/추가 인원 필드를 순서대로 만든다', () => {
    const embed = buildParticipantReport(stat, '2026-10-06');

    expect(embed.fields).toEqual([
      { name: '박람회 이름', value: '광주 박람회' },
      { name: '어제 박람회 등록 인원', value: '100' },
      { name: '2026-10-06 박람회 등록 인원', value: '120' },
      { name: '추가 등록 인원', value: '+20' },
    ]);
  });

  it('증가가 없으면 +0, 감소하면 부호 중복 없이 음수로 표시한다', () => {
    const added = (current: number) =>
      buildParticipantReport({ ...stat, applicationPerson: current }, 'd')
        .fields[3].value;

    expect(added(100)).toBe('+0');
    expect(added(95)).toBe('-5');
  });
});
