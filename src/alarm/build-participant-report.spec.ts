import {
  buildParticipantReport,
  reportSignature,
} from './build-participant-report';

const stat = {
  expoId: 'expo-1',
  title: '광주 박람회',
  confirmed: 4,
  waiting: 2,
  sessions: [
    { title: '10/31 오전', confirmed: 3 },
    { title: '10/31 오후', confirmed: 2 },
  ],
  yesterdayConfirmed: 3,
};

describe('buildParticipantReport', () => {
  it('고유 확정 인원과 대기, 회차별 확정 인원을 함께 보인다 (회차 합은 전체와 다를 수 있다)', () => {
    const embed = buildParticipantReport(stat, '2026-10-19');

    expect(embed.fields).toEqual([
      { name: '박람회 이름', value: '광주 박람회' },
      { name: '어제 박람회 등록 인원', value: '3' },
      { name: '2026-10-19 박람회 등록 인원', value: '4' },
      { name: '추가 등록 인원', value: '+1' },
      { name: '대기 인원', value: '2' },
      { name: '10/31 오전 확정 인원', value: '3' },
      { name: '10/31 오후 확정 인원', value: '2' },
    ]);
  });

  it('증가가 없으면 +0, 취소로 줄면 부호 중복 없이 음수로 표시한다', () => {
    const added = (yesterdayConfirmed: number) =>
      buildParticipantReport({ ...stat, yesterdayConfirmed }, 'd').fields[3]
        .value;

    expect(added(4)).toBe('+0');
    expect(added(8)).toBe('-4');
  });
});

describe('reportSignature', () => {
  it('인원이 같으면 같고, 확정·대기·회차 인원 중 하나라도 바뀌면 다르다', () => {
    const base = reportSignature(stat);

    expect(reportSignature({ ...stat, title: '제목만 변경' })).toBe(base);
    expect(reportSignature({ ...stat, confirmed: 3 })).not.toBe(base);
    expect(reportSignature({ ...stat, waiting: 0 })).not.toBe(base);
    expect(
      reportSignature({
        ...stat,
        sessions: [stat.sessions[0], { title: '10/31 오후', confirmed: 1 }],
      }),
    ).not.toBe(base);
  });
});
