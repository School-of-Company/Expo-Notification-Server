import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { SmsEventConsumer } from './sms-event.consumer';
import {
  EventInProgressError,
  SentEventPublishError,
  SmsDeliveryUnknownError,
} from './sms-errors';
import { SmsEventGuard } from './sms-event.guard';
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
      offset: '12',
      key: Buffer.from('k'),
      value: Buffer.from(JSON.stringify(payload)),
    },
    topic: 'notification.sms.requested',
    partition: 0,
  }) as never;

describe('SmsEventConsumer', () => {
  const config = createAppConfig();
  let client: {
    connect: jest.Mock;
    subscribe: jest.Mock;
    run: jest.Mock;
    disconnect: jest.Mock;
    commitOffsets: jest.Mock;
  };
  let producer: { connect: jest.Mock; send: jest.Mock; disconnect: jest.Mock };
  let kafka: { consumer: jest.Mock; producer: jest.Mock };
  let service: { handle: jest.Mock };
  let guard: { recordFailure: jest.Mock; clearFailures: jest.Mock };
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
      commitOffsets: jest.fn(),
    };
    producer = { connect: jest.fn(), send: jest.fn(), disconnect: jest.fn() };
    kafka = {
      consumer: jest.fn().mockReturnValue(client),
      producer: jest.fn().mockReturnValue(producer),
    };
    service = { handle: jest.fn() };
    guard = {
      recordFailure: jest.fn().mockResolvedValue(1),
      clearFailures: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new SmsEventConsumer(
      kafka as never,
      config,
      guard as unknown as SmsEventGuard,
      service as unknown as SmsEventService,
    );
    await consumer.onApplicationBootstrap();
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
    expect(guard.recordFailure).not.toHaveBeenCalled();
  });

  it('처리 전에 현재 오프셋을 저장한다 (실패한 첫 메시지가 재시작 때 유실되지 않게)', async () => {
    await eachMessage(toMessage(drawResult));

    expect(client.commitOffsets).toHaveBeenCalledWith([
      { topic: 'notification.sms.requested', partition: 0, offset: '12' },
    ]);
    expect(client.commitOffsets.mock.invocationCallOrder[0]).toBeLessThan(
      service.handle.mock.invocationCallOrder[0],
    );
  });

  it('현재 위치를 저장하지 못하면 문자를 처리하지 않고 재시도한다', async () => {
    client.commitOffsets.mockRejectedValue(new Error('broker down'));

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'broker down',
    );
    expect(service.handle).not.toHaveBeenCalled();
    expect(guard.recordFailure).not.toHaveBeenCalled();
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
    guard.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts - 1);

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'gateway down',
    );
    expect(producer.send).not.toHaveBeenCalled();
  });

  it('재시도 상한에 도달하면 원본을 DLQ로 보내고 던지지 않는다', async () => {
    service.handle.mockRejectedValue(new Error('insufficient balance'));
    guard.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);

    await expect(eachMessage(toMessage(drawResult))).resolves.toBeUndefined();

    expect(guard.recordFailure).toHaveBeenCalledWith('e1');
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'notification.sms.requested.dlq',
      messages: [
        {
          key: Buffer.from('k'),
          value: Buffer.from(JSON.stringify(drawResult)),
          headers: { 'x-source-topic': 'notification.sms.requested' },
        },
      ],
    });
  });

  it('DLQ로 보낼 때 실패 카운터를 지운다 (DLQ 재처리가 곧바로 다시 DLQ로 가지 않게)', async () => {
    service.handle.mockRejectedValue(new Error('insufficient balance'));
    guard.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);

    await eachMessage(toMessage(drawResult));

    expect(guard.clearFailures).toHaveBeenCalledWith('e1');
  });

  it('DLQ 전송이 성공하면 실패 카운터 정리 오류로 원본을 재전달하지 않는다', async () => {
    service.handle.mockRejectedValue(new Error('gateway down'));
    guard.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);
    guard.clearFailures.mockRejectedValue(new Error('redis down'));

    await expect(eachMessage(toMessage(drawResult))).resolves.toBeUndefined();
    expect(producer.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['발행 실패', new SentEventPublishError('publish failed')],
    ['처리 중 대기', new EventInProgressError('in progress')],
  ])(
    '%s는 실패 횟수에 세지 않고 던진다 (DLQ로 보내면 이벤트가 사라짐)',
    async (_name, error) => {
      service.handle.mockRejectedValue(error);

      await expect(eachMessage(toMessage(drawResult))).rejects.toBe(error);
      expect(guard.recordFailure).not.toHaveBeenCalled();
      expect(producer.send).not.toHaveBeenCalled();
    },
  );

  it('DLQ 발행까지 실패하면 던져서 이벤트를 잃지 않는다', async () => {
    service.handle.mockRejectedValue(new Error('insufficient balance'));
    guard.recordFailure.mockResolvedValue(config.sms.eventMaxAttempts);
    producer.send.mockRejectedValue(new Error('broker down'));

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'broker down',
    );
  });

  it('접수 결과 불명은 재전달하지 않고 원본을 UNKNOWN 헤더로 DLQ에 보관한 뒤 다음으로 넘어간다', async () => {
    service.handle.mockRejectedValue(new SmsDeliveryUnknownError('unknown'));

    await expect(eachMessage(toMessage(drawResult))).resolves.toBeUndefined();

    expect(guard.recordFailure).not.toHaveBeenCalled();
    expect(producer.send).toHaveBeenCalledWith({
      topic: config.kafka.topics.smsDeadLetter,
      messages: [
        {
          key: Buffer.from('k'),
          value: Buffer.from(JSON.stringify(drawResult)),
          headers: {
            'x-source-topic': 'notification.sms.requested',
            'x-sms-delivery': 'UNKNOWN',
          },
        },
      ],
    });
  });

  it('UNKNOWN 보관용 DLQ 발행이 실패하면 던져서 원본을 잃지 않는다 (재전달돼도 재발송은 guard가 막음)', async () => {
    service.handle.mockRejectedValue(new SmsDeliveryUnknownError('unknown'));
    producer.send.mockRejectedValue(new Error('broker down'));

    await expect(eachMessage(toMessage(drawResult))).rejects.toThrow(
      'broker down',
    );
    expect(guard.recordFailure).not.toHaveBeenCalled();
  });

  it('종료 시 consumer와 producer 연결을 끊는다', async () => {
    await consumer.onModuleDestroy();

    expect(client.disconnect).toHaveBeenCalled();
    expect(producer.disconnect).toHaveBeenCalled();
  });
});

describe('SmsEventConsumer 동시 처리 (consumerConcurrency>1)', () => {
  type BatchHandler = (payload: never) => Promise<void>;
  const setup = async (concurrency: number) => {
    let eachBatch: BatchHandler | undefined;
    const client = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn((o: { eachBatch: BatchHandler }) => {
        eachBatch = o.eachBatch;
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
    const service = { handle: jest.fn() };
    const guard = {
      recordFailure: jest.fn().mockResolvedValue(1),
      clearFailures: jest.fn().mockResolvedValue(undefined),
    };
    const base = createAppConfig();
    await new SmsEventConsumer(
      kafka as never,
      { ...base, sms: { ...base.sms, consumerConcurrency: concurrency } },
      guard as unknown as SmsEventGuard,
      service as unknown as SmsEventService,
    ).onApplicationBootstrap();
    const resolveOffset = jest.fn<void, [string]>();
    const run = (messages: unknown[]) =>
      eachBatch!({
        batch: { topic: 't', partition: 0, messages },
        resolveOffset,
        heartbeat: jest.fn(),
        isRunning: () => true,
        isStale: () => false,
      } as never);
    return { client, service, resolveOffset, run };
  };
  const msg = (offset: string, key: string | null, eventId: string) => ({
    offset,
    key: key ? Buffer.from(key) : null,
    value: Buffer.from(JSON.stringify({ ...drawResult, eventId })),
  });

  it('키가 다른 메시지는 병렬로, 같은 키는 순서대로 처리하고 오프셋을 모두 resolve한다', async () => {
    const { client, service, resolveOffset, run } = await setup(3);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    service.handle.mockImplementation(async (e: { eventId: string }) => {
      started.push(e.eventId);
      await gate;
    });

    const done = run([
      msg('0', 'a', 'a1'),
      msg('1', 'a', 'a2'),
      msg('2', 'b', 'b1'),
      msg('3', null, 'n1'),
    ]);
    await new Promise((r) => setImmediate(r));
    // a2는 a1이 끝나기 전에 시작하지 않는다
    expect(started.sort()).toEqual(['a1', 'b1', 'n1']);
    release();
    await done;

    expect(started).toContain('a2');
    expect(started.indexOf('a1')).toBeLessThan(started.indexOf('a2'));
    expect(client.commitOffsets).toHaveBeenCalledTimes(1);
    expect(resolveOffset.mock.calls.map((c: string[]) => c[0])).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });

  it('중간 메시지가 실패하면 앞에서부터 연속 성공한 오프셋까지만 resolve하고 던진다', async () => {
    const { service, resolveOffset, run } = await setup(3);
    const error = new Error('boom');
    service.handle.mockImplementation((e: { eventId: string }) =>
      e.eventId === 'b1' ? Promise.reject(error) : Promise.resolve(),
    );

    await expect(
      run([msg('0', 'a', 'a1'), msg('1', 'b', 'b1'), msg('2', 'c', 'c1')]),
    ).rejects.toBe(error);

    expect(resolveOffset.mock.calls.map((c: string[]) => c[0])).toEqual(['0']);
  });
});
