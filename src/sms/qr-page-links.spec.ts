import { buildQrPageLinks } from './qr-page-links';
import type { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrLinkError } from './sms-errors';
import { renderQrSms } from './sms-message.templates';

const template =
  'https://expo.example/qr?expoId={expoId}&type={participationType}&id={id}&code={code}';
const event: ParticipantRegisteredEvent = {
  eventId: 'e1',
  expoId: 'expo-1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '01012345678',
  participants: [{ id: 42, code: '_-aB09'.repeat(3) + '1234' }],
};

describe('buildQrPageLinks', () => {
  it('expoId의 쿼리 특수문자를 안전하게 인코딩한다', () => {
    const links = buildQrPageLinks(template, {
      ...event,
      expoId: '박람회 &?/#=+',
    });
    const url = new URL(links[0]?.url ?? '');
    expect(url.searchParams.get('expoId')).toBe('박람회 &?/#=+');
    expect([...url.searchParams.keys()]).toEqual([
      'expoId',
      'type',
      'id',
      'code',
    ]);
    expect(url.searchParams.get('code')).toBe('_-aB09'.repeat(3) + '1234');
    expect(url.hash).toBe('');
  });

  it.each([
    'javascript:alert({id})',
    template.replace('https:', 'http:'),
    template.replace('/qr?', '/image?'),
    template.replace('{code}', 'fixed'),
    template.replace('type=', 'participationType='),
    template.replace('id={id}', 'id=0'),
    template + '&code={code}',
    template + '&phoneNumber={phoneNumber}',
    template + '#fragment',
    template.replace('https://', 'https://user:pass@'),
    template.replace('expo.example', '{id}.example'),
    template + '&unknown={unknown}',
    ' ' + template,
  ])('Client 계약과 다른 템플릿을 거부한다: %s', (invalid) => {
    expect(() => buildQrPageLinks(invalid, event)).toThrow(QrLinkError);
  });

  it.each([1, 2, 3, 4, 5])(
    '%s명 최대값 fixture 본문은 한 통 LMS 상한 이내다',
    (count) => {
      const participants = Array.from({ length: count }, (_, i) => ({
        id: Number.MAX_SAFE_INTEGER - i,
        code: 'a'.repeat(22),
      }));
      const links = buildQrPageLinks(template, {
        ...event,
        expoId: '12345678-1234-1234-1234-123456789abc',
        id: Number.MAX_SAFE_INTEGER,
        participants,
      });
      const { text } = renderQrSms({
        expoName: '광주 박람회',
        links: links.map(({ url }, i) => ({
          label: '가'.repeat(10) + (i === 0 ? '(대표자)' : ''),
          url,
        })),
      });
      expect(links).toHaveLength(count);
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(90);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2000);
    },
  );
});
