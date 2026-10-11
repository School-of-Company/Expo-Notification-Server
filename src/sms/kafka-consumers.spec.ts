import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { ParticipantRegisteredConsumer } from './participant-registered.consumer';
import { QrSmsService } from './qr-sms.service';
import { SmsEventGuard } from './sms-event.guard';

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
    commitOffsets: jest.fn(),
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
  clearFailures: jest.fn().mockResolvedValue(undefined),
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
    ).onApplicationBootstrap();

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
    ).onApplicationBootstrap();

    await emit({ ...event, phoneNumber: 'bad' });

    expect(qrSms.handle).not.toHaveBeenCalled();
  });
});
