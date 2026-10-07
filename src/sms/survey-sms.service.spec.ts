import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { EntryRecordedEvent } from './participant-event.schema';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';
import { SmsEventGuard } from './sms-event.guard';
import { SmsSenderProvider } from './sms-sender.provider';
import { SurveySmsService } from './survey-sms.service';

const entry: EntryRecordedEvent = {
  eventId: 'e1',
  expoId: 'expo 1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '01012345678',
};

describe('SurveySmsService', () => {
  let dedupe: { claim: jest.Mock; complete: jest.Mock; release: jest.Mock };
  let sender: { send: jest.Mock };

  const create = (
    sms: Partial<ReturnType<typeof createAppConfig>['sms']> = {},
  ) => {
    const base = createAppConfig();
    return new SurveySmsService(
      { ...base, sms: { ...base.sms, ...sms } },
      new SmsEventGuard(dedupe as unknown as SmsEventDedupeStore),
      sender as unknown as SmsSenderProvider,
    );
  };

  beforeEach(() => {
    dedupe = {
      claim: jest.fn().mockResolvedValue('claimed'),
      complete: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    sender = { send: jest.fn().mockResolvedValue({ total: 1, failedTo: [] }) };
  });

  it('설문 URL 템플릿의 {expoId}를 URL 인코딩해 채우고 일반 발신번호로 보낸다', async () => {
    await create().handle(entry);

    const [[message]] = sender.send.mock.calls[0] as [
      [{ to: string; from: string; text: string }],
    ];
    expect(message.to).toBe('01012345678');
    expect(message.from).toBe(createAppConfig().sms.fromStandardNumber);
    expect(message.text).toContain('https://survey.test/expo/expo%201');
    expect(message.text).toContain('광주 박람회 설문조사');
  });

  it('일반 참가자가 아니면 보내지 않는다', async () => {
    await create().handle({ ...entry, participationType: 'TRAINEE' });

    expect(dedupe.claim).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('설문 URL 템플릿이 없으면 선점도 발송도 하지 않는다', async () => {
    await create({ surveyUrlTemplate: undefined }).handle(entry);

    expect(dedupe.claim).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('이미 처리한 eventId는 보내지 않는다', async () => {
    dedupe.claim.mockResolvedValue('done');

    await create().handle(entry);

    expect(sender.send).not.toHaveBeenCalled();
  });

  it('발송이 실패하면 선점을 풀고 던진다', async () => {
    sender.send.mockResolvedValue({ total: 1, failedTo: ['01012345678'] });

    await expect(create().handle(entry)).rejects.toThrow(
      'survey sms delivery failed',
    );
    expect(dedupe.release).toHaveBeenCalledWith('e1');
  });
});
