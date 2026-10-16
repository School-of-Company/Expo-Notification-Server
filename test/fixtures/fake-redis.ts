import { IN_WINDOW_LUA, OPEN_WINDOW_LUA } from '../../src/sms/sms-auth.store';

type Hash = Record<string, string>;

export class FakeRedis {
  private readonly hashes = new Map<string, Hash>();
  private readonly strings = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  private hash(key: string): Hash {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, {});
    }
    return this.hashes.get(key)!;
  }

  hincrby(key: string, field: string, by: number): Promise<number> {
    const hash = this.hash(key);
    hash[field] = String(Number(hash[field] ?? 0) + by);
    return Promise.resolve(Number(hash[field]));
  }

  incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return Promise.resolve(next);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  hset(
    key: string,
    fieldOrValues: string | Record<string, string | number>,
    value?: string | number,
  ): Promise<number> {
    const hash = this.hash(key);
    const values =
      typeof fieldOrValues === 'string'
        ? { [fieldOrValues]: value! }
        : fieldOrValues;
    for (const [field, fieldValue] of Object.entries(values)) {
      hash[field] = String(fieldValue);
    }
    return Promise.resolve(Object.keys(values).length);
  }

  hsetnx(key: string, field: string, value: string | number): Promise<number> {
    const hash = this.hash(key);
    if (field in hash) {
      return Promise.resolve(0);
    }
    hash[field] = String(value);
    return Promise.resolve(1);
  }

  hgetall(key: string): Promise<Hash> {
    return Promise.resolve({ ...(this.hashes.get(key) ?? {}) });
  }

  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.strings.has(key)) {
      return Promise.resolve(null);
    }
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  exists(key: string): Promise<number> {
    return Promise.resolve(
      this.strings.has(key) || this.hashes.has(key) || this.sets.has(key)
        ? 1
        : 0,
    );
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.strings.delete(key) ? 1 : 0);
  }

  // 만료가 없으므로 SMS 인증 창 스크립트의 창 토큰 비교만 흉내 낸다. TTL 경합은 실제 Redis 통합 테스트가 본다.
  eval(
    script: string,
    _numKeys: number,
    key: string,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const [first, second, ...rest] = args.map(String);
    if (script === OPEN_WINDOW_LUA) {
      if (!this.hashes.get(key)?.window) {
        this.hashes.set(key, { window: second });
      }
      const hash = this.hash(key);
      hash.sendCount = String(Number(hash.sendCount ?? 0) + 1);
      return Promise.resolve([Number(hash.sendCount), hash.window]);
    }
    if (script === IN_WINDOW_LUA) {
      if (this.hashes.get(key)?.window !== first) {
        return Promise.resolve(null);
      }
      if (second === 'HINCRBY') {
        return this.hincrby(key, rest[0], Number(rest[1]));
      }
      const values: Hash = {};
      for (let i = 0; i < rest.length; i += 2) {
        values[rest[i]] = rest[i + 1];
      }
      return this.hset(key, values);
    }
    throw new Error('FakeRedis.eval: unsupported script');
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(key) ?? [])]);
  }

  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    const chain = {
      sadd: (key: string, member: string) => {
        operations.push(() => {
          if (!this.sets.has(key)) {
            this.sets.set(key, new Set());
          }
          this.sets.get(key)!.add(member);
          return Promise.resolve(1);
        });
        return chain;
      },
      incr: (key: string) => {
        operations.push(() => this.incr(key));
        return chain;
      },
      hincrby: (key: string, field: string, by: number) => {
        operations.push(() => this.hincrby(key, field, by));
        return chain;
      },
      expire: () => {
        operations.push(() => this.expire());
        return chain;
      },
      hset: (key: string, values: Record<string, string | number>) => {
        operations.push(() => this.hset(key, values));
        return chain;
      },
      hsetnx: (key: string, field: string, value: string | number) => {
        operations.push(() => this.hsetnx(key, field, value));
        return chain;
      },
      exec: async () =>
        (await Promise.all(operations.map((operation) => operation()))).map(
          (result) => [null, result],
        ),
    };
    return chain;
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}
