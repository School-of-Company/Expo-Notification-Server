import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { EntryRecordedConsumer } from './entry-recorded.consumer';
import { ParticipantRegisteredConsumer } from './participant-registered.consumer';
import { QrSmsService } from './qr-sms.service';
import { SmsEventGuard } from './sms-event.guard';
import { SurveySmsService } from './survey-sms.service';

const config = createAppConfig();

function fakeKafka() {
  let eachMessage: EachMessageHandler | undefined;
  const client = {
    connect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn((options: { eachMessage: EachMessageHandler }) => {
      eachMessage = options.eachMessage;
    }),
    disconnect: jest.fn(),
  };
  const producer = {
    connect: jest.fn(),
    send: jest.fn(),
    disconnect: jest.fn(),
  };
  const kafka = {
    consumer: jest.fn().mockReturnValue(client),
    producer: jest.fn().mockReturnValue(producer),
  };
  return {
    kafka,
    client,
    producer,
    emit: (payload: unknown) =>
      eachMessage!({
        message: { key: null, value: Buffer.from(JSON.stringify(payload)) },
      } as never),
  };
}

const event = {
  eventId: 'e1',
  expoId: 'expo-1',
  participationType: 'STANDARD',
  id: 42,
  phoneNumber: '010-1234-5678',
};
const guard = {
  recordFailure: jest.fn().mockResolvedValue(1),
  clearFailures: jest.fn(),
};

describe('ParticipantRegisteredConsumer', () => {
  it('User 등록 완료 토픽을 전용 그룹으로 구독하고, 정규화한 이벤트를 QR 문자 서비스로 넘긴다', async () => {
    const { kafka, client, emit } = fakeKafka();
    const qrSms = { handle: jest.fn() };
    await new ParticipantRegisteredConsumer(
      kafka as never,
      config,
      guard as unknown as SmsEventGuard,
      qrSms as unknown as QrSmsService,
    ).onModuleInit();

    expect(kafka.consumer).toHaveBeenCalledWith({
      groupId: 'expo-notification-server.sms.participant-registered',
    });
    expect(client.subscribe).toHaveBeenCalledWith({
      topic: 'user.participant.registered',
      fromBeginning: false,
    });

    await emit(event);

    expect(qrSms.handle).toHaveBeenCalledWith({
      ...event,
      phoneNumber: '01012345678',
    });
  });

  it('스키마가 틀린 메시지는 건너뛴다', async () => {
    const { kafka, emit } = fakeKafka();
    const qrSms = { handle: jest.fn() };
    await new ParticipantRegisteredConsumer(
      kafka as never,
      config,
      guard as unknown as SmsEventGuard,
      qrSms as unknown as QrSmsService,
    ).onModuleInit();

    await emit({ ...event, phoneNumber: 'bad' });

    expect(qrSms.handle).not.toHaveBeenCalled();
  });
});

describe('EntryRecordedConsumer', () => {
  it('Attention 입장 토픽을 전용 그룹으로 구독하고 설문 문자 서비스로 넘긴다', async () => {
    const { kafka, client, emit } = fakeKafka();
    const survey = { handle: jest.fn() };
    await new EntryRecordedConsumer(
      kafka as never,
      config,
      guard as unknown as SmsEventGuard,
      survey as unknown as SurveySmsService,
    ).onModuleInit();

    expect(kafka.consumer).toHaveBeenCalledWith({
      groupId: 'expo-notification-server.sms.entry-recorded',
    });
    expect(client.subscribe).toHaveBeenCalledWith({
      topic: 'attention.entry.recorded',
      fromBeginning: false,
    });

    await emit(event);

    expect(survey.handle).toHaveBeenCalledWith({
      ...event,
      phoneNumber: '01012345678',
    });
  });

  it('재시도 상한에 도달하면 원본을 출처 토픽 헤더와 함께 DLQ로 보낸다', async () => {
    const { kafka, producer, emit } = fakeKafka();
    const survey = {
      handle: jest.fn().mockRejectedValue(new Error('gateway down')),
    };
    const exhausted = {
      recordFailure: jest.fn().mockResolvedValue(config.sms.eventMaxAttempts),
      clearFailures: jest.fn(),
    };
    await new EntryRecordedConsumer(
      kafka as never,
      config,
      exhausted as unknown as SmsEventGuard,
      survey as unknown as SurveySmsService,
    ).onModuleInit();

    await expect(emit(event)).resolves.toBeUndefined();

    expect(producer.send).toHaveBeenCalledWith({
      topic: 'notification.sms.requested.dlq',
      messages: [
        expect.objectContaining({
          headers: { 'x-source-topic': 'attention.entry.recorded' },
        }),
      ],
    });
  });
});
