import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';

describe('QrSmsSentPublisher', () => {
  const producer = {
    connect: jest.fn(),
    send: jest.fn(),
    disconnect: jest.fn(),
  };
  const kafka = { producer: jest.fn().mockReturnValue(producer) };
  const publisher = new QrSmsSentPublisher(kafka as never, createAppConfig());

  beforeEach(() => jest.clearAllMocks());

  it('notification.qr-sms.sent 토픽에 eventId를 파티션 키로 JSON을 발행한다', async () => {
    const event = {
      eventId: 'e1',
      expoId: 'expo-1',
      participationType: 'STANDARD' as const,
      id: 42,
    };

    await publisher.publish(event);

    expect(producer.send).toHaveBeenCalledWith({
      topic: 'notification.qr-sms.sent',
      messages: [{ key: 'e1', value: JSON.stringify(event) }],
    });
  });

  it('발행 실패는 그대로 던진다', async () => {
    producer.send.mockRejectedValue(new Error('broker down'));

    await expect(
      publisher.publish({
        eventId: 'e1',
        expoId: 'x',
        participationType: 'STANDARD',
        id: 1,
      }),
    ).rejects.toThrow('broker down');
  });

  it('기동 시 연결하고 종료 시 연결을 끊는다', async () => {
    await publisher.onModuleInit();
    await publisher.onModuleDestroy();

    expect(producer.connect).toHaveBeenCalled();
    expect(producer.disconnect).toHaveBeenCalled();
  });
});
