import { EachMessageHandler } from 'kafkajs';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AlarmReportService } from './alarm-report.service';
import { ExpoApplicantCountConsumer } from './expo-applicant-count.consumer';

const toMessage = (payload: unknown) =>
  ({ message: { value: Buffer.from(JSON.stringify(payload)) } }) as never;

describe('ExpoApplicantCountConsumer', () => {
  let client: {
    connect: jest.Mock;
    subscribe: jest.Mock;
    run: jest.Mock;
    disconnect: jest.Mock;
  };
  let kafka: { consumer: jest.Mock };
  let service: { recordApplicantCount: jest.Mock };
  let eachMessage: EachMessageHandler;

  beforeEach(async () => {
    client = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn((options: { eachMessage: EachMessageHandler }) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: jest.fn(),
    };
    kafka = { consumer: jest.fn().mockReturnValue(client) };
    service = { recordApplicantCount: jest.fn() };
    await new ExpoApplicantCountConsumer(
      kafka as never,
      createAppConfig(),
      service as unknown as AlarmReportService,
    ).onModuleInit();
  });

  it('설정된 그룹/토픽으로 구독한다', () => {
    expect(kafka.consumer).toHaveBeenCalledWith({
      groupId: 'expo-notification-server.alarm',
    });
    expect(client.subscribe).toHaveBeenCalledWith({
      topic: 'expo.applicant-count.updated',
      fromBeginning: false,
    });
  });

  it('유효한 이벤트는 서비스로 넘긴다', async () => {
    const event = {
      eventId: 'e1',
      version: 1,
      expoId: 'a',
      expoTitle: 'A',
      applicationPerson: 5,
    };

    await eachMessage(toMessage(event));

    expect(service.recordApplicantCount).toHaveBeenCalledWith(event);
  });

  it.each([
    [
      '음수 인원',
      {
        eventId: 'e1',
        version: 1,
        expoId: 'a',
        expoTitle: 'A',
        applicationPerson: -1,
      },
    ],
    [
      'expoId 누락',
      { eventId: 'e1', version: 1, expoTitle: 'A', applicationPerson: 1 },
    ],
  ])('%s 이벤트는 건너뛴다', async (_name, payload) => {
    await eachMessage(toMessage(payload));

    expect(service.recordApplicantCount).not.toHaveBeenCalled();
  });
});
