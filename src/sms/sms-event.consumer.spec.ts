import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { SmsEventConsumer } from './sms-event.consumer';
import { SmsEventService } from './sms-event.service';

const drawResult = {
  eventId: 'e1',
  version: 1,
  type: 'DRAW_RESULT',
  phoneNumber: '01012345678',
  drawNumber: 1,
};

const toMessage = (payload: unknown) =>
  ({
    message: {
      key: Buffer.from('k'),
      value: Buffer.from(JSON.stringify(payload)),
    },
  }) as never;

describe('SmsEventConsumer', () => {
  const config = createAppConfig();
  let client: {
    connect: jest.Mock;
    subscribe: jest.Mock;
    run: jest.Mock;
    disconnect: jest.Mock;
  };
  let producer: { connect: jest.Mock; send: jest.Mock; disconnect: jest.Mock };
  let kafka: { consumer: jest.Mock; producer: jest.Mock };
  let service: { handle: jest.Mock; recordFailure: jest.Mock };
  let eachMessage: EachMessageHandler;
  let consumer: SmsEventConsumer;

  beforeEach(async () => {
    client = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn((options: { eachMessage: EachMessageHandler }) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: jest.fn(),
    };
    producer = { connect: jest.fn(), send: jest.fn(), disconnect: jest.fn() };
    kafka = {
      consumer: jest.fn().mockReturnValue(client),
      producer: jest.fn().mockReturnValue(producer),
    };
    service = {
      handle: jest.fn(),
      recordFailure: jest.fn().mockResolvedValue(1),
    };
    consumer = new SmsEventConsumer(
      kafka as never,
      config,
      service as unknown as SmsEventService,
    );
    await consumer.onModuleInit();
  });

  it('설정된 그룹/토픽으로 구독한다', () => {
    expect(kafka.consumer).toHaveBeenCalledWith({
      groupId: 'expo-notification-server.sms',
    });
    expect(client.subscribe).toHaveBeenCalledWith({
      topic: 'notification.sms.requested',
      fromBeginning: false,
    });
  });

  it('유효한 이벤트는 서비스로 넘긴다', async () => {
    await eachMessage(toMessage(drawResult));

    expect(service.handle).toHaveBeenCalledWith(drawResult);
    expect(service.recordFailure).not.toHaveBeenCalled();
  });

  it('스키마가 틀린 메시지는 던지지 않고 건너뛴다 (무한 재시도 방지)', async () => {
    await expect(
      eachMessage(toMessage({ type: 'NOPE' })),
    ).resolves.toBeUndefined();

    expect(service.handle).not.toHaveBeenCalled();
  });

  it('JSON이 아닌 메시지도 건너뛴다', async () => {
    await eachMessage({ message: { value: Buffer.from('{oops') } } as never);

    expect(service.handle).not.toHaveBeenCalled();
  });

  it('재시도 상한 전의 실패는 던져서 Kafka가 재전달하게 한다', async () => {
    service.handle.mockRejectedValue(new Error('gateway down'));
    service.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts - 1);

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'gateway down',
    );
    expect(producer.send).not.toHaveBeenCalled();
  });

  it('재시도 상한에 도달하면 원본을 DLQ로 보내고 던지지 않는다', async () => {
    service.handle.mockRejectedValue(new Error('insufficient balance'));
    service.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);

    await expect(eachMessage(toMessage(drawResult))).resolves.toBeUndefined();

    expect(service.recordFailure).toHaveBeenCalledWith('e1');
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'notification.sms.requested.dlq',
      messages: [
        {
          key: Buffer.from('k'),
          value: Buffer.from(JSON.stringify(drawResult)),
        },
      ],
    });
  });

  it('DLQ 발행까지 실패하면 던져서 이벤트를 잃지 않는다', async () => {
    service.handle.mockRejectedValue(new Error('insufficient balance'));
    service.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);
    producer.send.mockRejectedValue(new Error('broker down'));

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'broker down',
    );
  });

  it('종료 시 consumer와 producer 연결을 끊는다', async () => {
    await consumer.onModuleDestroy();

    expect(client.disconnect).toHaveBeenCalled();
    expect(producer.disconnect).toHaveBeenCalled();
  });
});
