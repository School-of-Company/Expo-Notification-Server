import type { ParticipantRegisteredEvent } from './participant-event.schema';
import { QrLinkError } from './sms-errors';

export function buildQrPageLinks(
  template: string,
  event: ParticipantRegisteredEvent,
): readonly {
  readonly id: number;
  readonly url: string;
}[] {
  const standard = event.participationType === 'STANDARD';
  const representativeId = event.representativeId ?? event.id;
  if (
    standard &&
    (!event.participants?.length ||
      event.participants.some(({ code }) => !code))
  ) {
    throw new QrLinkError('STANDARD QR event requires participants and code');
  }
  const participants = standard
    ? [...(event.participants ?? [])].sort(
        (a, b) =>
          Number(b.id === representativeId) - Number(a.id === representativeId),
      )
    : [{ id: event.id, code: undefined }];
  const keys = standard
    ? ['expoId', 'participationType', 'id', 'code']
    : ['expoId', 'participationType', 'id', 'phoneNumber'];
  if (
    keys.some((key) => !template.includes(`{${key}}`)) ||
    /[\s\p{C}]/u.test(template) ||
    /^[^?]*[{}]/.test(template)
  ) {
    throw new QrLinkError('invalid QR URL template');
  }
  return participants.map(({ id, code }) => {
    const values: Record<string, string> = {
      expoId: event.expoId,
      participationType: event.participationType,
      id: String(id),
      ...(standard ? { code: code ?? '' } : { phoneNumber: event.phoneNumber }),
    };
    const rendered = template.replace(
      /\{([^{}]+)\}/g,
      (_match: string, key: string) => encodeURIComponent(values[key] ?? ''),
    );
    let url: URL;
    try {
      url = new URL(rendered);
    } catch {
      throw new QrLinkError('invalid QR URL template');
    }
    const expected = new Map([
      ['expoId', event.expoId],
      ['type', event.participationType],
      ['id', String(id)],
      standard ? ['code', code ?? ''] : ['phoneNumber', event.phoneNumber],
    ]);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/qr' ||
      [...url.searchParams].length !== expected.size ||
      [...expected].some(
        ([key, value]) => url.searchParams.get(key) !== value,
      ) ||
      /[{}]/.test(rendered)
    ) {
      throw new QrLinkError('QR URL does not match Client contract');
    }
    return { id, url: url.href };
  });
}
