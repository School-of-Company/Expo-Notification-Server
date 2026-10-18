import Redis from 'ioredis';
import { createAppConfig } from '../fixtures/app-config.fixture';
import { SmsAuthService } from '../../src/sms/sms-auth.service';
import { SmsAuthStore } from '../../src/sms/sms-auth.store';
import { SmsSenderProvider } from '../../src/sms/sms-sender.provider';
import { LocalInfra, until } from './local-infra';

// 실제 Redis TTL로 "만료 직전 요청이 멈췄다가 만료 후 재개"되는 경합을 재현한다 (#47).
describe('SMS 인증 창 만료 경합 (실제 Redis)', () => {
  const infra = new LocalInfra();
  const phone = '01012345678';
  const key = `sms:auth:${phone}`;
  let redis: Redis;
  let store: SmsAuthStore;
  let service: SmsAuthService;
  let sent: string[];

  const expired = () => until(async () => (await redis.exists(key)) === 0);
  const persistentKeys = async () => {
    const keys = await redis.keys('sms:auth:*');
    const ttls = await Promise.all(keys.map((k) => redis.ttl(k)));
    return keys.filter((_, i) => ttls[i] === -1);
  };
  // 실제 store 호출이 끝난 뒤 resume이 풀릴 때까지 다음 단계로 넘어가지 않게 붙잡는다.
  const pauseAfter = (
    method: 'increaseSendCount' | 'find',
    resume: () => Promise<void>,
  ) => {
    const original = store[method].bind(store) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    jest
      .spyOn(store, method)
      .mockImplementationOnce(async (...args: unknown[]) => {
        const result = await original(...args);
        await resume();
        return result as never;
      });
  };

  beforeAll(async () => {
    await infra.start();
    redis = new Redis({ host: '127.0.0.1', port: infra.redisPort });
  });
  beforeEach(async () => {
    await redis.flushdb();
    sent = [];
    const config = createAppConfig();
    config.sms.authCodeTtlSeconds = 2;
    store = new SmsAuthStore(redis);
    const sender = {
      send: jest.fn((messages: Array<{ text: string }>) => {
        sent.push(
          ...messages.map((m) => /\[(\d{4})\]/.exec(m.text)?.[1] ?? m.text),
        );
        return Promise.resolve({ total: messages.length, failedTo: [] });
      }),
    };
    service = new SmsAuthService(
      config,
      store,
      sender as unknown as SmsSenderProvider,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    redis?.disconnect();
    infra.stop();
  });

  it('재발송이 카운트 후 멈춘 사이 창이 만료되면 저장·발송하지 않고 TTL 없는 키도 남기지 않는다', async () => {
    await service.sendCode(phone);
    const firstCode = sent[0];
    pauseAfter('increaseSendCount', expired);

    await expect(service.sendCode(phone)).rejects.toMatchObject({
      status: 409,
    });

    expect(sent).toEqual([firstCode]);
    expect(await persistentKeys()).toEqual([]);
    expect(await redis.exists(key)).toBe(0);
    await expect(service.verifyCode(phone, firstCode)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('멈췄던 재발송은 그 사이 열린 새 창의 코드를 덮어쓰지 않는다', async () => {
    await service.sendCode(phone);
    let newWindowCode = '';
    pauseAfter('increaseSendCount', async () => {
      await expired();
      await service.sendCode(phone);
      newWindowCode = sent[sent.length - 1];
    });

    await expect(service.sendCode(phone)).rejects.toMatchObject({
      status: 409,
    });

    expect(sent).toHaveLength(2);
    expect(await redis.hget(key, 'code')).toBe(newWindowCode);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    await expect(
      service.verifyCode(phone, newWindowCode),
    ).resolves.toBeUndefined();
  });

  it('조회 후 창이 만료되면 검증하지 않고 TTL 없는 키도 만들지 않는다', async () => {
    await service.sendCode(phone);
    pauseAfter('find', expired);

    await expect(service.verifyCode(phone, sent[0])).rejects.toMatchObject({
      status: 404,
    });

    expect(await redis.exists(key)).toBe(0);
    expect(await persistentKeys()).toEqual([]);
  });

  it('만료된 창의 코드로 그 사이 열린 새 창을 인증하지 못한다', async () => {
    await service.sendCode(phone);
    const oldCode = sent[0];
    pauseAfter('find', async () => {
      await expired();
      await service.sendCode(phone);
    });

    await expect(service.verifyCode(phone, oldCode)).rejects.toMatchObject({
      status: 404,
    });

    expect(await redis.hmget(key, 'verified', 'verifyAttemptCount')).toEqual([
      '0',
      null,
    ]);
  });

  it('창 안의 재발송은 최초 만료 시각과 검증 시도 횟수를 유지하고 코드만 바꾼다', async () => {
    await service.sendCode(phone);
    const firstExpiry = await redis.pexpiretime(key);
    const wrong = sent[0] === '0000' ? '0001' : '0000';
    await expect(service.verifyCode(phone, wrong)).rejects.toMatchObject({
      status: 400,
    });

    await service.sendCode(phone);

    expect(await redis.pexpiretime(key)).toBe(firstExpiry);
    expect(await redis.hmget(key, 'sendCount', 'verifyAttemptCount')).toEqual([
      '2',
      '1',
    ]);
    expect(await redis.hget(key, 'code')).toBe(sent[1]);
  });

  it('이전 버전이 남긴 TTL 없는 키는 인증에 쓰이지 않고 다음 발송이 새 창으로 바꾼다', async () => {
    await redis.hset(key, { code: '1111', verified: '0', sendCount: '5' });

    await expect(service.verifyCode(phone, '1111')).rejects.toMatchObject({
      status: 404,
    });
    await service.sendCode(phone);

    expect(await persistentKeys()).toEqual([]);
    expect(await redis.hget(key, 'sendCount')).toBe('1');
    await expect(service.verifyCode(phone, sent[0])).resolves.toBeUndefined();
  });

  it('만료된 코드는 인증되지 않는다', async () => {
    await service.sendCode(phone);
    await expired();

    await expect(service.verifyCode(phone, sent[0])).rejects.toMatchObject({
      status: 404,
    });
    expect(await persistentKeys()).toEqual([]);
  });
});
