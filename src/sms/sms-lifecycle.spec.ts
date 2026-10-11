import { Test } from '@nestjs/testing';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { ParticipantRegisteredConsumer } from './participant-registered.consumer';
import { QrSmsSentPublisher } from './qr-sms-sent.publisher';
import { QrSmsService } from './qr-sms.service';
import { SmsEventGuard } from './sms-event.guard';

describe('SMS Kafka lifecycle', () => {
  it('발행 producer 연결 후 소비를 시작하고 소비 종료 후 producer를 닫는다', async () => {
    let publisherReady = false;
    const stopped: string[] = [];
    const client = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn(() => {
        expect(publisherReady).toBe(true);
        return Promise.resolve();
      }),
      disconnect: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        stopped.push('consumer');
      }),
    };
    const producer = {
      connect: jest.fn(),
      disconnect: jest.fn(() => {
        stopped.push('producer');
        return Promise.resolve();
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: APP_CONFIG, useValue: createAppConfig() },
        {
          provide: KAFKA_CLIENT,
          useValue: {
            consumer: () => client,
            producer: () => producer,
          },
        },
        { provide: SmsEventGuard, useValue: {} },
        { provide: QrSmsService, useValue: {} },
        QrSmsSentPublisher,
        ParticipantRegisteredConsumer,
      ],
    }).compile();
    const publisher = moduleRef.get<QrSmsSentPublisher>(QrSmsSentPublisher);
    jest.spyOn(publisher, 'onModuleInit').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await QrSmsSentPublisher.prototype.onModuleInit.call(publisher);
      publisherReady = true;
    });
    try {
      await moduleRef.init();
      expect(client.run).toHaveBeenCalledTimes(1);
    } finally {
      await moduleRef.close();
    }
    expect(stopped).toEqual(['consumer', 'producer', 'producer']);
  });
});
