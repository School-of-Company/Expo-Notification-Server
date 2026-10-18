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
import {
  isSolapiUrl,
  solapiSendManyResponse,
} from './fixtures/solapi-fetch.fixture';
import { FakeRedis } from './fixtures/fake-redis';

const config = createAppConfig();

let registeredParticipantCount = 30;
const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
const internalResponse = (url: string): Response => {
  if (url.endsWith('/internal/standard-participants/names'))
    return jsonResponse([{ participantId: 42, name: '홍길동' }]);
  if (url.includes('/internal/expo?'))
    return jsonResponse({
      content: [{ expoId: 'expo-1', title: '광주 박람회' }],
      hasNext: false,
    });
  if (url.endsWith('/internal/expos/expo-1/participant-stats'))
    return jsonResponse({ expoId: 'expo-1', registeredParticipantCount });
  return { ok: true, status: 204 } as Response;
};

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
  let producerSend: jest.Mock;

  const emit = (groupId: string, payload: unknown) =>
    handlers.get(groupId)!({
      message: { value: Buffer.from(JSON.stringify(payload)) },
    } as never);

  type SentSms = { to: string; from: string; text: string };
  const sentBatches = () => solapiSend.mock.calls as [SentSms[]][];
  const lastSentCode = () =>
    /인증번호 (\d{4})입니다/.exec(sentBatches().at(-1)![0][0].text)![1];
  const embedFields = (call: unknown[]) =>
    (
      JSON.parse((call[1] as RequestInit).body as string) as {
        embeds: { fields: { value: string }[] }[];
      }
    ).embeds[0].fields;

  beforeEach(async () => {
    config.sms = createAppConfig().sms;
    handlers.clear();
    solapiSend = jest.fn().mockResolvedValue({ failedMessageList: [] });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        isSolapiUrl(input)
          ? solapiSendManyResponse(init, solapiSend)
          : Promise.resolve(internalResponse(urlOf(input))),
      );

    producerSend = jest.fn();
    const fakeKafka = {
      producer: () => ({
        connect: jest.fn(),
        send: producerSend,
        disconnect: jest.fn(),
      }),
      consumer: ({ groupId }: { groupId: string }) => ({
        commitOffsets: jest.fn(),
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

    it('expoId를 보내도 받기만 하고 승인된 K1 문구로 보낸다', async () => {
      await request(app.getHttpServer())
        .post('/sms')
        .send({ phoneNumber: '01012345678', expoId: 'expo-1' })
        .expect(200);

      expect(sentBatches()[0][0][0].text).toMatch(
        /^\[AI교육원\] 2026 AI 미래교육 박람회\(AI·SW체험한마당\) 신청 인증번호 \d{4}입니다\. \(5분 이내 입력\)$/,
      );
    });

    it.each([
      ['전화번호 형식 오류', 'post', { phoneNumber: 'abc' }],
      ['전화번호 누락', 'post', {}],
      [
        'expoId 형식 오류',
        'post',
        { phoneNumber: '01012345678', expoId: '../x' },
      ],
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
      expect(producerSend).not.toHaveBeenCalled();

      await expect(
        emit(config.kafka.smsGroupId, drawResult),
      ).resolves.toBeUndefined();
      expect(producerSend).toHaveBeenCalledWith(
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

  describe('QR 문자 (Kafka → User 이름 조회)', () => {
    const registered = {
      eventId: 'reg-1',
      expoId: 'expo-1',
      participationType: 'STANDARD',
      id: 42,
      phoneNumber: '010-1234-5678',
      participants: [{ id: 42, code: 'a'.repeat(22) }],
    };
    const registeredGroup = `${config.kafka.smsGroupId}.participant-registered`;
    const callsTo = (suffix: string) =>
      (fetchSpy.mock.calls as [FetchInput, RequestInit?][]).filter(([url]) =>
        urlOf(url).endsWith(suffix),
      );

    const sentEvents = () =>
      (
        producerSend.mock.calls as [
          { topic: string; messages: { key: string; value: string }[] },
        ][]
      )
        .filter(([message]) => message.topic === config.kafka.topics.qrSmsSent)
        .map(([message]) => ({
          key: message.messages[0].key,
          value: JSON.parse(message.messages[0].value) as Record<
            string,
            unknown
          >,
        }));

    it('등록 완료 이벤트: QR 페이지 링크 문자를 보내고 발송 완료 이벤트를 발행한다 (sms-try HTTP 호출은 없다)', async () => {
      await emit(registeredGroup, registered);

      expect(callsTo('/internal/standard-participants/names')).toHaveLength(1);
      expect(sentBatches()[0][0][0]).toEqual({
        to: '01012345678',
        from: config.sms.fromStandardNumber,
        text: expect.stringContaining(
          '홍길동(대표자): https://expo.test/qr?expoId=expo-1&type=STANDARD&id=42&code=',
        ) as string,
      });
      expect(sentEvents()).toEqual([
        {
          key: 'reg-1',
          value: {
            eventId: 'reg-1',
            expoId: 'expo-1',
            participationType: 'STANDARD',
            id: 42,
          },
        },
      ]);
      expect(callsTo('/internal/participants/sms-try')).toHaveLength(0);
    });

    it('같은 이벤트 재전달은 이름 조회, 문자, 발행을 다시 하지 않는다', async () => {
      await emit(registeredGroup, registered);
      await emit(registeredGroup, registered);

      expect(callsTo('/internal/standard-participants/names')).toHaveLength(1);
      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(sentEvents()).toHaveLength(1);
    });

    it('User 이름 조회 404는 fallback 문자를 계속 발송한다', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });
      await emit(registeredGroup, registered);
      expect(sentBatches()[0][0][0].text).toContain('대표자:');
      expect(sentEvents()).toHaveLength(1);
    });

    it('5명은 대표자 먼저 나머지 순서대로 한 문자에 담는다', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });
      await emit(registeredGroup, {
        ...registered,
        participants: [45, 43, 42, 44, 46].map((id) => ({
          id,
          code: 'a'.repeat(22),
        })),
      });
      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(sentBatches()[0][0]).toHaveLength(1);
      expect(sentBatches()[0][0][0].text.match(/id=\d+/g)).toEqual([
        'id=42',
        'id=45',
        'id=43',
        'id=44',
        'id=46',
      ]);
      expect(sentEvents()).toHaveLength(1);
    });

    it('템플릿 미설정은 소비를 끝내되 문자/완료/발행 기록이 없다', async () => {
      config.sms.qrUrlTemplate = '';
      await emit(registeredGroup, registered);
      expect(solapiSend).not.toHaveBeenCalled();
      expect(sentEvents()).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        await app.get<FakeRedis>(REDIS_CLIENT).get('sms:event:reg-1'),
      ).toBeNull();
    });

    it('누락된 STANDARD code는 재시도 후 DLQ로 이동하고 성공을 기록하지 않는다', async () => {
      const unsupported = { ...registered, participants: [{ id: 42 }] };
      for (let i = 1; i < config.sms.eventMaxAttempts; i += 1) {
        await expect(emit(registeredGroup, unsupported)).rejects.toThrow(
          'requires participants and code',
        );
      }
      await emit(registeredGroup, unsupported);
      expect(solapiSend).not.toHaveBeenCalled();
      expect(sentEvents()).toHaveLength(0);
      expect(producerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: config.kafka.topics.smsDeadLetter,
        }),
      );
      expect(
        await app.get<FakeRedis>(REDIS_CLIENT).get('sms:event:reg-1'),
      ).toBeNull();
    });

    it('malformed code는 기존 스키마 실패 정책으로 미발송/미발행한다', async () => {
      await emit(registeredGroup, {
        ...registered,
        participants: [{ id: 42, code: 'bad' }],
      });
      expect(solapiSend).not.toHaveBeenCalled();
      expect(producerSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('legacy done 이벤트는 문자나 완료 이벤트 없이 끝낸다', async () => {
      await app.get<FakeRedis>(REDIS_CLIENT).set('sms:event:reg-1', 'done');
      await emit(registeredGroup, { ...registered, participants: undefined });
      expect(solapiSend).not.toHaveBeenCalled();
      expect(sentEvents()).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('연수자 이벤트는 연수 발신번호로 보내고 발송 완료 이벤트는 발행하지 않는다', async () => {
      await emit(registeredGroup, {
        ...registered,
        participationType: 'TRAINEE',
      });

      expect(sentBatches()[0][0][0].from).toBe(config.sms.fromTraineeNumber);
      expect(sentEvents()).toHaveLength(0);
    });

    it('SMS가 명시적으로 거부되면 문자 완료 이벤트 없이 던진 뒤, 재전달되면 다시 시도한다', async () => {
      solapiSend.mockResolvedValueOnce({
        failedMessageList: [{ to: '01012345678' }],
      });

      await expect(emit(registeredGroup, registered)).rejects.toThrow();
      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(sentEvents()).toHaveLength(0);

      await emit(registeredGroup, registered);
      expect(solapiSend).toHaveBeenCalledTimes(2);
      expect(sentEvents()).toHaveLength(1);
    });

    it('접수 결과를 모르면(응답 유실) 완료 이벤트 없이 원본을 DLQ에 보관하고 재전달돼도 다시 보내지 않는다', async () => {
      solapiSend.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(emit(registeredGroup, registered)).resolves.toBeUndefined();
      await expect(emit(registeredGroup, registered)).resolves.toBeUndefined();

      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(sentEvents()).toHaveLength(0);
      expect(producerSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: config.kafka.topics.smsDeadLetter,
          messages: [
            expect.objectContaining({
              headers: expect.objectContaining({
                'x-sms-delivery': 'UNKNOWN',
              }) as unknown,
            }),
          ],
        }),
      );
    });

    it('발행이 실패해도 재전달 때 문자는 다시 보내지 않고 발행만 다시 시도한다', async () => {
      producerSend.mockRejectedValueOnce(new Error('broker down'));

      await expect(emit(registeredGroup, registered)).rejects.toThrow(
        'publish failed',
      );
      expect(solapiSend).toHaveBeenCalledTimes(1);

      await emit(registeredGroup, registered);

      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(callsTo('/internal/standard-participants/names')).toHaveLength(1);
      expect(sentEvents()).toHaveLength(2);
    });

    it('발행이 계속 실패해도 DLQ로 보내지 않는다 (문자는 나갔는데 발송 완료 이벤트가 사라지면 안 됨)', async () => {
      producerSend.mockRejectedValue(new Error('topic missing'));

      for (let i = 0; i < config.sms.eventMaxAttempts + 2; i += 1) {
        await expect(emit(registeredGroup, registered)).rejects.toThrow();
      }

      expect(solapiSend).toHaveBeenCalledTimes(1);
      expect(
        (producerSend.mock.calls as [{ topic: string }][]).filter(
          ([message]) => message.topic === config.kafka.topics.smsDeadLetter,
        ),
      ).toHaveLength(0);

      producerSend.mockReset();
      producerSend.mockResolvedValue(undefined);
      await emit(registeredGroup, registered);
      expect(sentEvents()).toHaveLength(1);
      expect(solapiSend).toHaveBeenCalledTimes(1);
    });

    it('입장 설문 문자 consumer를 시작하지 않는다', () => {
      expect([...handlers.keys()].sort()).toEqual(
        [config.kafka.smsGroupId, registeredGroup].sort(),
      );
      expect(solapiSend).not.toHaveBeenCalled();
    });
  });

  describe('등록 인원 알람', () => {
    it('이벤트 없이 내부 API로 조회한 인원을 Discord에 보내고, 자정 스냅샷 후엔 증가분만 보인다 (#54)', async () => {
      registeredParticipantCount = 30;
      const alarm = app.get(AlarmReportService);
      const discordCalls = () =>
        (fetchSpy.mock.calls as Parameters<typeof fetch>[]).filter(
          ([input]) => urlOf(input) === config.discord.participantNumberUrl,
        );

      await alarm.sendParticipantNumberReport();

      expect(discordCalls()).toHaveLength(1);
      const fields = embedFields(discordCalls()[0]);
      expect(fields[0].value).toBe('광주 박람회');
      expect(fields[1].value).toBe('0');
      expect(fields[2].value).toBe('30');
      expect(fields[3].value).toBe('+30');

      await alarm.saveYesterdayApplicantCount();
      registeredParticipantCount = 33;
      fetchSpy.mockClear();
      await alarm.sendParticipantNumberReport();

      const next = embedFields(discordCalls()[0]);
      expect(next[1].value).toBe('30');
      expect(next[2].value).toBe('33');
      expect(next[3].value).toBe('+3');
    });
  });

  it('헬스체크 GET / 가 응답한다', () =>
    request(app.getHttpServer()).get('/').expect(200));
});
