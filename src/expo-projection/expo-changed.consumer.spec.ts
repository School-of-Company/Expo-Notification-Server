import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { ExpoChangedConsumer } from './expo-changed.consumer';
import { ExpoProjectionService } from './expo-projection.service';

const enabled = createAppConfig({
  expoProjection: {
    ...createAppConfig().expoProjection,
    enabled: true,
    maxAttempts: 3,
  },
});

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
    emit: (payload: unknown, offset = '5') =>
      eachMessage!({
        partition: 0,
        message: {
          key: Buffer.from('expo-1'),
          value: Buffer.from(JSON.stringify(payload)),
          offset,
        },
      } as never),
  };
}

const event = {
  schemaVersion: 1,
  eventId: 'e1',
  version: 42,
  occurredAt: '2030-01-01T00:00:00Z',
  expoId: 'expo-1',
  deleted: false,
  expo: {
    title: '광주 박람회',
    description: '설명',
    startedDay: '2030-01-01',
    finishedDay: '2030-01-02',
    deleting: false,
  },
  standardPrograms: [],
  trainingPrograms: [],
  preregisterSessions: [{ id: 7, title: '1회차', capacity: 30 }],
};

describe('ExpoChangedConsumer', () => {
  const start = async (config = enabled) => {
    const fake = fakeKafka();
    const service = { apply: jest.fn().mockResolvedValue(true) };
    await new ExpoChangedConsumer(
      config,
      fake.kafka as never,
      service as unknown as ExpoProjectionService,
    ).onApplicationBootstrap();
    return { ...fake, service };
  };

  it('기능이 꺼져 있으면 Kafka에 붙지 않는다', async () => {
    const { kafka } = await start(createAppConfig());

    expect(kafka.consumer).not.toHaveBeenCalled();
    expect(kafka.producer).not.toHaveBeenCalled();
  });

  it('전용 그룹으로 처음부터 구독하고 읽는 필드만 서비스에 넘긴다', async () => {
    const { kafka, client, emit, service } = await start();

    expect(kafka.consumer).toHaveBeenCalledWith({
      groupId: 'expo-notification-server.expo-changed',
    });
    expect(client.subscribe).toHaveBeenCalledWith({
      topic: 'expo.expo.changed',
      fromBeginning: true,
    });

    await emit(event);

    expect(service.apply).toHaveBeenCalledWith({
      schemaVersion: 1,
      eventId: 'e1',
      version: 42,
      expoId: 'expo-1',
      deleted: false,
      expo: {
        title: '광주 박람회',
        startedDay: '2030-01-01',
        finishedDay: '2030-01-02',
        deleting: false,
      },
      preregisterSessions: [{ id: 7, title: '1회차' }],
    });
  });

  it('tombstone은 상태 없이 받는다', async () => {
    const { emit, service } = await start();

    await emit({
      schemaVersion: 1,
      eventId: 'e2',
      version: 43,
      occurredAt: '2030-01-01T00:00:00Z',
      expoId: 'expo-1',
      deleted: true,
    });

    expect(service.apply).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true, version: 43 }),
    );
  });

  it.each([
    ['형식이 틀린 메시지', { ...event, version: 'x' }],
    ['모르는 schemaVersion', { ...event, schemaVersion: 2 }],
  ])('%s는 반영하지 않고 바로 DLQ로 옮긴다', async (_, payload) => {
    const { emit, producer, service } = await start();

    await emit(payload);

    expect(service.apply).not.toHaveBeenCalled();
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'expo.expo.changed.dlq',
      messages: [
        expect.objectContaining({
          key: Buffer.from('expo-1'),
          headers: expect.objectContaining({
            'x-source-topic': 'expo.expo.changed',
          }) as unknown,
        }),
      ],
    });
  });

  it('반영 실패는 던져 재전달시키고 maxAttempts번째 실패에서 DLQ로 옮긴다', async () => {
    const { emit, producer, service } = await start();
    service.apply.mockRejectedValue(new Error('redis down'));

    await expect(emit(event)).rejects.toThrow('redis down');
    await expect(emit(event)).rejects.toThrow('redis down');
    expect(producer.send).not.toHaveBeenCalled();

    await expect(emit(event)).resolves.toBeUndefined();
    expect(producer.send).toHaveBeenCalledTimes(1);
    expect(service.apply).toHaveBeenCalledTimes(3);
  });

  it('실패 횟수는 메시지(offset)마다 따로 센다', async () => {
    const { emit, producer, service } = await start();
    service.apply.mockRejectedValueOnce(new Error('redis down'));

    await expect(emit(event, '5')).rejects.toThrow('redis down');
    await emit(event, '5');
    service.apply.mockRejectedValueOnce(new Error('redis down'));
    await expect(emit(event, '6')).rejects.toThrow('redis down');

    expect(producer.send).not.toHaveBeenCalled();
  });
});
