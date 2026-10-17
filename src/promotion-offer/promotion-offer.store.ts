import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  promotionOfferRecordSchema,
  PromotionOfferRetryError,
} from './promotion-offer.schema';
import type {
  PromotionOfferEvent,
  PromotionOfferRecord,
} from './promotion-offer.schema';

const queue = 'promotion-offer:{notifications}:due';
const key = (id: string) => `promotion-offer:{notifications}:record:${id}`;
const lock = (id: string) => `promotion-offer:{notifications}:lock:${id}`;

// Same durable Redis pattern as the completed-promotion store, under its own keys.
@Injectable()
export class PromotionOfferStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(event: PromotionOfferEvent): Promise<void> {
    const record: PromotionOfferRecord = {
      event,
      status: 'PENDING',
      failures: 0,
    };
    await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 then
        redis.call('SET', KEYS[1], ARGV[1])
        redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
      end
      return 1`,
      2,
      key(event.eventId),
      queue,
      JSON.stringify(record),
      Date.now(),
      event.eventId,
    );
    const saved = await this.get(event.eventId);
    if (saved && JSON.stringify(saved.event) !== JSON.stringify(event))
      throw new PromotionOfferRetryError();
  }

  async get(id: string): Promise<PromotionOfferRecord | null> {
    const raw = await this.redis.get(key(id));
    if (raw === null) return null;
    const body: unknown = JSON.parse(raw);
    return promotionOfferRecordSchema.parse(body);
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    return (await this.redis.set(lock(id), token, 'EX', 30, 'NX')) === 'OK'
      ? token
      : null;
  }

  async save(record: PromotionOfferRecord, token: string): Promise<void> {
    const due =
      record.report || record.status === 'PENDING'
        ? Date.now() + 5000
        : record.status === 'ACCEPTED'
          ? Date.now() + 30000
          : 0;
    const result = await this.redis.eval(
      `
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[2])
      if ARGV[3] == '0' then redis.call('ZREM', KEYS[3], ARGV[4])
      else redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4]) end
      return 1`,
      3,
      key(record.event.eventId),
      lock(record.event.eventId),
      queue,
      token,
      JSON.stringify(record),
      due,
      record.event.eventId,
    );
    if (result !== 1) throw new PromotionOfferRetryError();
  }

  async release(id: string, token: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lock(id),
      token,
    );
  }

  async due(): Promise<string[]> {
    return this.redis.zrangebyscore(queue, 0, Date.now(), 'LIMIT', 0, 100);
  }
}
