import { renderApplicationResult } from './application-result-message';
import { applicationResultEventSchema } from './application-result.schema';
import type { ApplicationResultEvent } from './application-result.schema';

const base = {
  eventId: 'app-1',
  version: 1,
  phoneNumber: '01012345678',
  expoId: 'expo-1',
  occurredAt: '2026-10-22T01:00:00Z',
  applicationUrl: 'https://expo.example/application',
};
const item = {
  participantName: '홍길동',
  title: 'AI 코딩 체험',
  startedAt: '2026-10-30T01:00:00Z',
  endedAt: '2026-10-30T02:00:00Z',
  location: 'A관 101호',
};

const parse = (event: unknown): ApplicationResultEvent =>
  applicationResultEventSchema.parse(event);
const render = (event: unknown) =>
  renderApplicationResult(parse(event), '광주 박람회').text;

describe('renderApplicationResult', () => {
  it('신청 확정은 이름·프로그램·한국 시간·장소를 보여 준다', () => {
    const text = render({ ...base, type: 'PROGRAM_CONFIRMED', items: [item] });

    expect(text).toBe(
      [
        '[광주 박람회] 프로그램 신청 확정 안내',
        '',
        '신청이 확정되었습니다.',
        '',
        '■ 홍길동',
        'AI 코딩 체험',
        '일시: 2026. 10. 30. 10:00 ~ 2026. 10. 30. 11:00 (한국시간)',
        '장소: A관 101호',
        '',
        '▶ 신청 확인: https://expo.example/application',
      ].join('\n'),
    );
  });

  it('대기 접수는 확정되지 않았음을 밝힌다', () => {
    const text = render({ ...base, type: 'PROGRAM_WAITLISTED', items: [item] });

    expect(text).toContain('아직 참가가 확정된 것이 아니며');
    expect(text).not.toContain('신청이 확정되었습니다');
  });

  it('관리자 취소는 주체를 밝히고 목록에 없는 신청은 유지된다고 안내한다', () => {
    const admin = render({
      ...base,
      type: 'PROGRAM_CANCELLED',
      cancelledBy: 'ADMIN',
      items: [item],
    });
    const user = render({
      ...base,
      type: 'PROGRAM_CANCELLED',
      cancelledBy: 'USER',
      items: [item],
    });

    expect(admin).toContain('관리자에 의해 아래 신청이(가) 취소되었습니다.');
    expect(user).not.toContain('관리자');
    expect(user).toContain('목록에 없는 신청은 취소되지 않았습니다.');
  });

  it('사전등록 일부 취소를 전체 취소처럼 안내하지 않는다', () => {
    const cancelled = (scope: 'ALL' | 'PARTIAL') =>
      render({
        ...base,
        type: 'PREREGISTER_CANCELLED',
        cancelledBy: 'USER',
        scope,
        items: [{ participantName: '홍길동', title: '10/30 회차' }],
      });

    expect(cancelled('PARTIAL')).toContain(
      '목록에 없는 등록은 그대로 유지됩니다.',
    );
    expect(cancelled('ALL')).not.toContain('유지됩니다');
    expect(cancelled('ALL')).not.toContain('일시:');
  });

  it('회차 추가는 회차마다 확정/대기 결과를 보여 준다', () => {
    const text = render({
      ...base,
      type: 'PREREGISTER_SESSION_ADDED',
      items: [
        { ...item, result: 'CONFIRMED' },
        { ...item, title: '다른 회차', result: 'WAITLISTED' },
      ],
    });

    expect(text).toContain('상태: 확정');
    expect(text).toContain('상태: 대기 (아직 확정되지 않음)');
  });

  it('참여 확인 만료는 확정되지 않았다고 안내한다', () => {
    const text = render({ ...base, type: 'OFFER_EXPIRED', items: [item] });

    expect(text).toContain('만료되었습니다');
    expect(text).toContain('확정되지 않았습니다');
  });

  it('URL이 없으면 안내 문구로 대신한다', () => {
    const text = render({
      ...base,
      applicationUrl: null,
      type: 'PROGRAM_CONFIRMED',
      items: [item],
    });

    expect(text).toContain('▶ 신청 확인: 신청시스템에서 확인해 주세요');
  });

  it('여러 대상자와 한글 장문도 미리보기 fixture로 검증한다', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...item,
      participantName: `참가자${index + 1}`,
    }));
    const text = render({ ...base, type: 'PROGRAM_CONFIRMED', items });

    expect(text).toContain('■ 참가자1\n');
    expect(text).toContain('■ 참가자10\n');
    // Solapi 장문(LMS) 상한 2000바이트.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2000);
  });
});

describe('applicationResultEventSchema', () => {
  const valid = { ...base, type: 'PROGRAM_CONFIRMED', items: [item] };

  it('senderType 기본값은 STANDARD다', () => {
    expect(parse(valid).senderType).toBe('STANDARD');
  });

  it.each([
    ['대표자 번호 형식 오류', { phoneNumber: '02-123' }],
    ['대상자 없음', { items: [] }],
    ['11명 초과', { items: Array.from({ length: 11 }, () => item) }],
    ['이름 누락', { items: [{ ...item, participantName: undefined }] }],
    ['종료가 시작보다 빠름', { items: [{ ...item, endedAt: item.startedAt }] }],
    ['시작만 있음', { items: [{ ...item, endedAt: undefined }] }],
    ['http URL', { applicationUrl: 'http://expo.example' }],
    [
      '제어문자 포함 이름',
      { items: [{ ...item, participantName: '홍\n길동' }] },
    ],
    ['version 불일치', { version: 2 }],
  ])('%s는 거부한다', (_name, patch) => {
    expect(
      applicationResultEventSchema.safeParse({ ...valid, ...patch }).success,
    ).toBe(false);
  });

  it('취소 유형은 취소 주체가, 회차 추가는 항목별 결과가 필수다', () => {
    expect(
      applicationResultEventSchema.safeParse({
        ...base,
        type: 'PROGRAM_CANCELLED',
        items: [item],
      }).success,
    ).toBe(false);
    expect(
      applicationResultEventSchema.safeParse({
        ...base,
        type: 'PREREGISTER_SESSION_ADDED',
        items: [item],
      }).success,
    ).toBe(false);
  });
});
