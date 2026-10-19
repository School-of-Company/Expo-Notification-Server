import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { promotionRecordSchema, PromotionRetryError } from './promotion.schema';
import type { PromotionEvent, PromotionRecord } from './promotion.schema';

const queue = 'promotion:{notifications}:due';
const recordPrefix = 'promotion:{notifications}:record:';
const key = (id: string) => `${recordPrefix}${id}`;
const lock = (id: string) => `promotion:{notifications}:lock:${id}`;

@Injectable()
export class PromotionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(event: PromotionEvent): Promise<void> {
    const record: PromotionRecord = { event, status: 'PENDING', failures: 0 };
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
      throw new PromotionRetryError();
  }

  async get(id: string): Promise<PromotionRecord | null> {
    const raw = await this.redis.get(key(id));
    if (raw === null) return null;
    const body: unknown = JSON.parse(raw);
    return promotionRecordSchema.parse(body);
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    return (await this.redis.set(lock(id), token, 'EX', 30, 'NX')) === 'OK'
      ? token
      : null;
  }

  async save(record: PromotionRecord, token: string): Promise<void> {
    const due =
      record.status === 'PENDING'
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
    if (result !== 1) throw new PromotionRetryError();
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

  // #32 읽기 전용 운영 점검. 원장/due ZSET을 바꾸지 않고, SCAN으로 나눠 읽어 Redis를 막지 않는다.
  async snapshot(limit: number): Promise<PromotionLedgerSnapshot> {
    // ioredis keyPrefix는 SCAN 패턴에 붙지 않으므로 직접 붙이고 떼어낸다.
    const prefix = this.redis.options.keyPrefix ?? '';
    const ids: string[] = [];
    let cursor = '0';
    let truncated = false;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}${recordPrefix}*`,
        'COUNT',
        200,
      );
      cursor = next;
      for (const raw of keys) {
        if (ids.length >= limit) {
          truncated = true;
          break;
        }
        ids.push(raw.slice(prefix.length + recordPrefix.length));
      }
    } while (cursor !== '0' && !truncated);
    const records: PromotionLedgerEntry[] = [];
    for (const id of ids) {
      const [raw, ttl] = await Promise.all([
        this.redis.get(key(id)),
        this.redis.ttl(key(id)),
      ]);
      if (raw === null) continue;
      records.push({ id, ttl, record: parseRecord(raw) });
    }
    const scored = await this.redis.zrange(
      queue,
      '0',
      String(limit - 1),
      'WITHSCORES',
    );
    const due: { id: string; score: number }[] = [];
    for (let i = 0; i + 1 < scored.length; i += 2)
      due.push({ id: scored[i], score: Number(scored[i + 1]) });
    return {
      records,
      due,
      dueTotal: await this.redis.zcard(queue),
      dueTtl: await this.redis.ttl(queue),
      truncated,
    };
  }

  // CONFIG/INFO가 ACL로 막혀 있으면 null로 두고 UNVERIFIED로 보고한다(실패로 위장하지 않는다).
  async redisSettings(): Promise<PromotionRedisSettings> {
    const config = async (name: string) => {
      try {
        const value = (await this.redis.config('GET', name)) as unknown;
        return Array.isArray(value) && typeof value[1] === 'string'
          ? value[1]
          : null;
      } catch {
        return null;
      }
    };
    let persistence: Record<string, string> | null = null;
    try {
      persistence = Object.fromEntries(
        (await this.redis.info('persistence'))
          .split(/\r?\n/)
          .filter((line) => line.includes(':') && !line.startsWith('#'))
          .map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at), line.slice(at + 1).trim()];
          }),
      );
    } catch {
      persistence = null;
    }
    return {
      appendonly: await config('appendonly'),
      maxmemoryPolicy: await config('maxmemory-policy'),
      persistence,
    };
  }
}

function parseRecord(raw: string): PromotionRecord | null {
  try {
    const parsed = promotionRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type PromotionLedgerEntry = {
  readonly id: string;
  readonly ttl: number;
  readonly record: PromotionRecord | null;
};
export type PromotionLedgerSnapshot = {
  readonly records: PromotionLedgerEntry[];
  readonly due: { readonly id: string; readonly score: number }[];
  readonly dueTotal: number;
  readonly dueTtl: number;
  readonly truncated: boolean;
};
export type PromotionRedisSettings = {
  readonly appendonly: string | null;
  readonly maxmemoryPolicy: string | null;
  readonly persistence: Record<string, string> | null;
};
