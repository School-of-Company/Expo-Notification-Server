import { deepMerge } from './deep-merge';

describe('deepMerge', () => {
  it('중첩 객체의 형제 키를 잃지 않고 같은 키는 override가 이긴다', () => {
    const merged = deepMerge(
      { sms: { apiKey: 'env', fromStandardNumber: '1' }, port: 1 },
      { sms: { apiKey: 'remote' } },
    );

    expect(merged).toEqual({
      sms: { apiKey: 'remote', fromStandardNumber: '1' },
      port: 1,
    });
  });

  it('배열은 병합하지 않고 통째로 교체한다', () => {
    expect(deepMerge({ brokers: ['a'] }, { brokers: ['b', 'c'] })).toEqual({
      brokers: ['b', 'c'],
    });
  });

  it('__proto__ 키는 무시한다', () => {
    const merged = deepMerge(
      {},
      JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<
        string,
        unknown
      >,
    );

    expect(merged).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });

  it('입력 객체를 변경하지 않는다', () => {
    const base = { a: { b: 1 } };
    deepMerge(base, { a: { b: 2 } });

    expect(base).toEqual({ a: { b: 1 } });
  });
});
