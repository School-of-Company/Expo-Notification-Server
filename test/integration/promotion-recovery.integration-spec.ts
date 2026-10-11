import { Logger } from '@nestjs/common';
import { PromotionStore } from '../../src/promotion/promotion.store';
import { LocalInfra } from './local-infra';
import { PromotionRuntime } from './promotion-runtime';
import { promoted } from './promotion-fixture';
import Redis from 'ioredis';

describe('promotion Redis crash and concurrency contracts', () => {
  const infra = new LocalInfra();
  let runtime: PromotionRuntime;
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await infra.start();
  });
  beforeEach(async () => {
    runtime = new PromotionRuntime(infra);
    await runtime.prepare();
  });
  afterEach(async () => {
    await runtime?.close();
  });
  afterAll(() => {
    try {
      infra.stop();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('retains SENDING on accepted result storage failure and survives lock expiry without resending', async () => {
    await runtime.start();
    const event = promoted();
    const healthyStore = new PromotionStore(runtime.redis);
    const spy = jest
      .spyOn(runtime.store, 'save')
      .mockImplementation((record, token) => {
        if (record.status === 'ACCEPTED')
          return Promise.reject(new Error('synthetic Redis failure'));
        return healthyStore.save(record, token);
      });
    await expect(runtime.service.handle(event)).rejects.toThrow(
      'synthetic Redis failure',
    );
    spy.mockRestore();
    expect((await runtime.store.get(event.eventId))?.status).toBe('SENDING');
    expect(
      await runtime.redis.exists(
        `promotion:{notifications}:lock:${event.eventId}`,
      ),
    ).toBe(0);
    await runtime.service.handle(event);
    expect(runtime.http.sms).toHaveLength(1);
    expect((await runtime.store.get(event.eventId))?.status).toBe('SENDING');
  });

  it('fences stale owners and suppresses concurrent processing', async () => {
    await runtime.start();
    const event = promoted();
    await runtime.store.enqueue(event);
    const token = await runtime.store.claim(event.eventId);
    if (!token) throw new Error('missing claim');
    await runtime.redis.set(
      `promotion:{notifications}:lock:${event.eventId}`,
      'replacement',
      'EX',
      30,
    );
    const record = await runtime.store.get(event.eventId);
    if (!record) throw new Error('missing record');
    await expect(
      runtime.store.save({ ...record, status: 'SENDING' }, token),
    ).rejects.toThrow();
    await runtime.store.release(event.eventId, token);
    await runtime.service.handle(event);
    expect(runtime.http.sms).toHaveLength(0);
    await runtime.redis.del(`promotion:{notifications}:lock:${event.eventId}`);
    await Promise.all([
      runtime.service.handle(event),
      runtime.service.handle(event),
    ]);
    expect(runtime.http.sms).toHaveLength(1);
  });

  it('does not send when real Redis ACL denies pre-send persistence and recovers safely', async () => {
    await runtime.start();
    const event = promoted();
    const username = `denied-${runtime.topic}`;
    await runtime.redis.acl(
      'SETUSER',
      username,
      'on',
      '>synthetic-only',
      '~*',
      '+ping',
      '+info',
      '+client',
      '+get',
    );
    const denied = new Redis({
      host: runtime.redis.options.host,
      port: runtime.redis.options.port,
      username,
      password: 'synthetic-only',
      keyPrefix: runtime.redis.options.keyPrefix,
      lazyConnect: true,
    });
    const deniedStore = new PromotionStore(denied);
    try {
      await denied.connect();
      const spy = jest
        .spyOn(runtime.store, 'save')
        .mockImplementation((record, token) => deniedStore.save(record, token));
      await expect(runtime.service.handle(event)).rejects.toThrow(/NOPERM/);
      spy.mockRestore();
      expect(runtime.http.sms).toHaveLength(0);
      expect((await runtime.store.get(event.eventId))?.status).toBe('PENDING');
      await runtime.retry(event.eventId);
      expect(runtime.http.sms).toHaveLength(1);
    } finally {
      denied.disconnect();
      await runtime.redis.acl('DELUSER', username);
    }
  });
});
