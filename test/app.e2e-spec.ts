import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EachMessageHandler } from 'kafkajs';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AlarmReportService } from '../src/alarm/alarm-report.service';
import { AppModule } from '../src/app.module';
import { APP_CONFIG } from '../src/config/app-config.constants';
import { KAFKA_CLIENT } from '../src/kafka/kafka.constants';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { SOLAPI_CLIENT } from '../src/sms/sms.constants';
import { createAppConfig } from './fixtures/app-config.fixture';
import { FakeRedis } from './fixtures/fake-redis';

const config = createAppConfig();

type FetchInput = Parameters<typeof fetch>[0];
const urlOf = (input: FetchInput): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

describe('Notification server (e2e)', () => {
  let app: INestApplication<App>;
  let solapiSend: jest.Mock;
  let fetchSpy: jest.SpyInstance;
  const handlers = new Map<string, EachMessageHandler>();
  let dlqSend: jest.Mock;

  const emit = (groupId: string, payload: unknown) =>
    handlers.get(groupId)!({
      message: { value: Buffer.from(JSON.stringify(payload)) },
    } as never);

  type SentSms = { to: string; from: string; text: string };
  const sentBatches = () => solapiSend.mock.calls as [SentSms[]][];
  const lastSentCode = () => sentBatches().at(-1)![0][0].text;
  const embedFields = (call: unknown[]) =>
    (
      JSON.parse((call[1] as RequestInit).body as string) as {
        embeds: { fields: { value: string }[] }[];
      }
    ).embeds[0].fields;

  beforeEach(async () => {
    handlers.clear();
    solapiSend = jest.fn().mockResolvedValue({ failedMessageList: [] });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/internal/qr-images')
          ? ({
              ok: true,
              status: 201,
              json: () => Promise.resolve({ url: 'https://s3.test/qr.jpg' }),
            } as Response)
          : ({ ok: true, status: 204 } as Response),
      ),
    );

    dlqSend = jest.fn();
    const fakeKafka = {
      producer: () => ({
        connect: jest.fn(),
        send: dlqSend,
        disconnect: jest.fn(),
      }),
      consumer: ({ groupId }: { groupId: string }) => ({
        connect: jest.fn(),
        subscribe: jest.fn(),
        run: jest.fn(({ eachMessage }: { eachMessage: EachMessageHandler }) => {
          handlers.set(groupId, eachMessage);
        }),
        disconnect: jest.fn(),
      }),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(KAFKA_CLIENT)
      .useValue(fakeKafka)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new FakeRedis())
      .overrideProvider(SOLAPI_CLIENT)
      .useValue({ send: solapiSend })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    fetchSpy.mockRestore();
  });

  describe('SMS 인증 (HTTP)', () => {
    it('코드 발송 → 올바른 코드 검증이 성공한다', async () => {
      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(200);

      const code = lastSentCode();
      expect(code).toMatch(/^\d{4}$/);
      expect(sentBatches()[0][0][0]).toMatchObject({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
      });

      await request(app.getHttpServer())
        .get('/sms')
        .query({ phoneNumber: '01012345678', code })
        .expect(200);
    });

    it('틀린 코드는 400, 발송 이력이 없으면 404', async () => {
      await request(app.getHttpServer())
        .get('/sms')
        .query({ phoneNumber: '01099998888', code: '1234' })
        .expect(404);

      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(200);
      const wrong = lastSentCode() === '0000' ? '0001' : '0000';

      await request(app.getHttpServer())
        .get('/sms')
        .query({ phoneNumber: '01012345678', code: wrong })
        .expect(400);
    });

    it('동시 검증 요청이 몰려도 상한을 넘은 시도는 비교하지 못하고 429', async () => {
      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(200);
      const code = lastSentCode();
      const wrong = code === '0000' ? '0001' : '0000';

      const statuses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          request(app.getHttpServer())
            .get('/sms')
            .query({
              phoneNumber: '01012345678',
              code: i === 19 ? code : wrong,
            })
            .then((res) => res.status),
        ),
      );

      expect(statuses.filter((status) => status === 400)).toHaveLength(
        config.sms.authMaxVerifyAttemptCount,
      );
      expect(statuses.filter((status) => status === 429).length).toBe(
        20 - config.sms.authMaxVerifyAttemptCount,
      );
    });

    it('POST /sms/verify(바디)로도 검증할 수 있다', async () => {
      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/sms/verify')
        .send({ phoneNumber: '01012345678', code: lastSentCode() })
        .expect(200);
    });

    it('검증 실패가 상한에 도달하면 올바른 코드도 429', async () => {
      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(200);
      const code = lastSentCode();
      const wrong = code === '0000' ? '0001' : '0000';

      for (let i = 0; i < config.sms.authMaxVerifyAttemptCount; i += 1) {
        await request(app.getHttpServer())
          .get('/sms')
          .query({ phoneNumber: '01012345678', code: wrong })
          .expect(400);
      }

      await request(app.getHttpServer())
        .get('/sms')
        .query({ phoneNumber: '01012345678', code })
        .expect(429);
    });

    it('발송 요청이 상한을 넘으면 429이고 더 이상 문자를 보내지 않는다', async () => {
      for (let i = 0; i < config.sms.authMaxSendCount; i += 1) {
        await request(app.getHttpServer())
          .post('/sms')
          .send({ phoneNumber: '01012345678' })
          .expect(200);
      }

      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(429);
      expect(solapiSend).toHaveBeenCalledTimes(config.sms.authMaxSendCount);
    });

    it.each([
      ['전화번호 형식 오류', 'post', { phoneNumber: 'abc' }],
      ['전화번호 누락', 'post', {}],
    ])('%s는 400이고 문자를 보내지 않는다', async (_name, _method, body) => {
      await request(app.getHttpServer()).post('/sms').send(body).expect(400);

      expect(solapiSend).not.toHaveBeenCalled();
    });

    it('문자 게이트웨이가 실패하면 502', async () => {
      solapiSend.mockResolvedValue({
        failedMessageList: [{ to: '01012345678' }],
      });

      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678' })
        .expect(502);
    });
  });

  describe('SMS 이벤트 (Kafka)', () => {
    const drawResult = {
      eventId: 'evt-1',
      version: 1,
      type: 'DRAW_RESULT',
      phoneNumber: '01012345678',
      drawNumber: 9,
    };

    it('이벤트를 받으면 문자를 보내고, 같은 eventId 재전달은 무시한다', async () => {
      await emit(config.kafka.smsGroupId, drawResult);
      await emit(config.kafka.smsGroupId, drawResult);

      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(sentBatches()[0][0][0].text).toContain('9번!');
    });

    it('발송이 전부 실패하면 던지고, 재전달되면 다시 발송을 시도한다', async () => {
      solapiSend.mockResolvedValueOnce({
        failedMessageList: [{ to: '01012345678' }],
      });

      await expect(emit(config.kafka.smsGroupId, drawResult)).rejects.toThrow();
      await emit(config.kafka.smsGroupId, drawResult);

      expect(solapiSend).toHaveBeenCalledTimes(2);
    });

    it('발송이 계속 실패해 재시도 상한에 도달하면 DLQ로 보내고 더는 던지지 않는다', async () => {
      solapiSend.mockResolvedValue({
        failedMessageList: [{ to: '01012345678' }],
      });

      for (let i = 1; i < config.sms.eventMaxAttempts; i += 1) {
        await expect(
          emit(config.kafka.smsGroupId, drawResult),
        ).rejects.toThrow();
      }
      expect(dlqSend).not.toHaveBeenCalled();

      await expect(
        emit(config.kafka.smsGroupId, drawResult),
      ).resolves.toBeUndefined();
      expect(dlqSend).toHaveBeenCalledWith(
        expect.objectContaining({ topic: config.kafka.topics.smsDeadLetter }),
      );
    });

    it('스키마가 틀린 이벤트는 문자를 보내지 않고 조용히 건너뛴다', async () => {
      await emit(config.kafka.smsGroupId, {
        ...drawResult,
        phoneNumber: 'bad',
      });

      expect(solapiSend).not.toHaveBeenCalled();
    });
  });

  describe('QR·설문 문자 (Kafka → Attention/User 내부 호출)', () => {
    const registered = {
      eventId: 'reg-1',
      expoId: 'expo-1',
      participationType: 'STANDARD',
      id: 42,
      phoneNumber: '010-1234-5678',
    };
    const registeredGroup = `${config.kafka.smsGroupId}.participant-registered`;
    const entryGroup = `${config.kafka.smsGroupId}.entry-recorded`;
    const callsTo = (suffix: string) =>
      (fetchSpy.mock.calls as [FetchInput, RequestInit?][]).filter(([url]) =>
        urlOf(url).endsWith(suffix),
      );

    it('등록 완료 이벤트: QR URL을 받아 문자를 보내고 sms-try를 호출한다', async () => {
      await emit(registeredGroup, registered);

      expect(callsTo('/internal/qr-images')).toHaveLength(1);
      expect(sentBatches()[0][0][0]).toEqual({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: expect.stringContaining('https://s3.test/qr.jpg') as string,
      });
      const [smsTry] = callsTo('/internal/participants/sms-try');
      expect(JSON.parse((smsTry[1] as RequestInit).body as string)).toEqual({
        expoId: 'expo-1',
        participationType: 'STANDARD',
        phoneNumber: '01012345678',
      });
    });

    it('같은 이벤트 재전달은 QR 생성, 문자, sms-try를 다시 하지 않는다 (sms-try 중복 증가 방지)', async () => {
      await emit(registeredGroup, registered);
      await emit(registeredGroup, registered);

      expect(callsTo('/internal/qr-images')).toHaveLength(1);
      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(callsTo('/internal/participants/sms-try')).toHaveLength(1);
    });

    it('연수자 이벤트는 연수 발신번호로 보내고 sms-try는 호출하지 않는다', async () => {
      await emit(registeredGroup, {
        ...registered,
        participationType: 'TRAINEE',
      });

      expect(sentBatches()[0][0][0].from).toBe(config.sms.fromTraineeNumber);
      expect(callsTo('/internal/participants/sms-try')).toHaveLength(0);
    });

    it('Attention이 실패하면 문자를 보내지 않고 던진 뒤, 재전달되면 다시 시도한다', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(emit(registeredGroup, registered)).rejects.toThrow();
      expect(solapiSend).not.toHaveBeenCalled();

      await emit(registeredGroup, registered);
      expect(solapiSend).toHaveBeenCalledTimes(1);
    });

    it('sms-try가 실패해도 던지지 않고 다시 호출하지도 않는다', async () => {
      fetchSpy.mockImplementation((input: FetchInput) =>
        Promise.resolve(
          urlOf(input).endsWith('/internal/qr-images')
            ? ({
                ok: true,
                status: 201,
                json: () => Promise.resolve({ url: 'https://s3.test/qr.jpg' }),
              } as Response)
            : ({ ok: false, status: 500 } as Response),
        ),
      );

      await expect(emit(registeredGroup, registered)).resolves.toBeUndefined();
      await emit(registeredGroup, registered);

      expect(callsTo('/internal/participants/sms-try')).toHaveLength(1);
    });

    it('입장 이벤트: 일반 참가자에게 설문 링크 문자를 보낸다', async () => {
      await emit(entryGroup, { ...registered, eventId: 'entry-1' });

      const { text, from } = sentBatches()[0][0][0];
      expect(from).toBe(config.sms.fromStandardNumber);
      expect(text).toContain('https://survey.test/expo/expo-1');
    });
  });

  describe('등록 인원 알람', () => {
    it('이벤트로 쌓은 인원을 리포트로 Discord에 보내고, 자정 스냅샷 후엔 증가분이 0이 된다', async () => {
      await emit(config.kafka.alarmGroupId, {
        eventId: 'c1',
        version: 1,
        expoId: 'expo-1',
        expoTitle: '광주 박람회',
        applicationPerson: 30,
      });
      const alarm = app.get(AlarmReportService);

      await alarm.sendParticipantNumberReport();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe(config.discord.participantNumberUrl);
      const fields = embedFields(fetchSpy.mock.calls[0] as unknown[]);
      expect(fields[1].value).toBe('0');
      expect(fields[2].value).toBe('30');
      expect(fields[3].value).toBe('+30');

      await alarm.saveYesterdayApplicantCount();
      fetchSpy.mockClear();
      await alarm.sendParticipantNumberReport();

      const next = embedFields(fetchSpy.mock.calls[0] as unknown[]);
      expect(next[1].value).toBe('30');
      expect(next[3].value).toBe('+0');
    });
  });

  it('헬스체크 GET / 가 응답한다', () =>
    request(app.getHttpServer()).get('/').expect(200));
});
