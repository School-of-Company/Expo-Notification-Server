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

  del(key: string): Promise<number> {
    return Promise.resolve(this.strings.delete(key) ? 1 : 0);
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
