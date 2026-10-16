import { Redis } from 'ioredis';
import { IN_WINDOW_LUA, OPEN_WINDOW_LUA, SmsAuthStore } from './sms-auth.store';
import { SmsEventDedupeStore } from './sms-event-dedupe.store';

describe('SmsAuthStore', () => {
  const exec = jest.fn();
  const chain: Record<string, jest.Mock> = {
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec,
  };
  const redis = {
    multi: jest.fn(() => chain),
    eval: jest.fn(),
    hgetall: jest.fn(),
  };
  const store = new SmsAuthStore(redis as unknown as Redis);

  beforeEach(() => {
    exec.mockReset();
    redis.eval.mockReset();
    redis.hgetall.mockReset();
  });

  // 창 만료·TTL 동작 자체는 test/integration/sms-auth-expiry.integration-spec.ts가 실제 Redis로 검증한다.
  it('발송 횟수 증가와 창 열기를 한 스크립트로 보내고 횟수와 창 토큰을 돌려준다', async () => {
    redis.eval.mockResolvedValue([2, 'w1']);

    await expect(store.increaseSendCount('010', 180)).resolves.toEqual({
      count: 2,
      window: 'w1',
    });
    expect(redis.eval).toHaveBeenCalledWith(
      OPEN_WINDOW_LUA,
      1,
      'sms:auth:010',
      180,
      expect.any(String),
    );
  });

  it('창 스크립트 결과 형태가 다르면 에러를 던진다', async () => {
    redis.eval.mockResolvedValue(null);

    await expect(store.increaseSendCount('010', 180)).rejects.toThrow(
      'unexpected sms auth window result',
    );
  });

  it('전체 발송 카운터는 시간 버킷 키를 INCR하고 TTL을 최초 1회만 건다', async () => {
    exec.mockResolvedValue([
      [null, 7],
      [null, 1],
    ]);

    await expect(store.increaseGlobalSendCount('2026-10-06T10')).resolves.toBe(
      7,
    );
    expect(chain.incr).toHaveBeenCalledWith('sms:auth:global:2026-10-06T10');
    expect(chain.expire).toHaveBeenCalledWith(
      'sms:auth:global:2026-10-06T10',
      7200,
      'NX',
    );
  });

  it('트랜잭션 명령이 실패하면 에러를 던진다', async () => {
    exec.mockResolvedValue([[new Error('OOM'), null]]);

    await expect(
      store.increaseGlobalSendCount('2026-10-06T10'),
    ).rejects.toThrow('OOM');
  });

  it('새 코드는 같은 창일 때만 저장하고, 시도 횟수는 초기화하지 않는다 (재발송으로 시도 횟수 리셋 방지)', async () => {
    redis.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(null);

    await expect(store.saveCode('010', 'w1', '1234')).resolves.toBe(true);
    await expect(store.saveCode('010', 'w1', '1234')).resolves.toBe(false);
    expect(redis.eval).toHaveBeenCalledWith(
      IN_WINDOW_LUA,
      1,
      'sms:auth:010',
      'w1',
      'HSET',
      'code',
      '1234',
      'verified',
      '0',
    );
  });

  it('코드나 창 토큰이 없으면 null, 있으면 상태를 파싱해 돌려준다', async () => {
    redis.hgetall.mockResolvedValueOnce({});
    redis.hgetall.mockResolvedValueOnce({ code: '1234', verified: '0' });
    redis.hgetall.mockResolvedValueOnce({
      code: '1234',
      verified: '1',
      window: 'w1',
    });

    await expect(store.find('010')).resolves.toBeNull();
    await expect(store.find('010')).resolves.toBeNull();
    await expect(store.find('010')).resolves.toEqual({
      code: '1234',
      verified: true,
      window: 'w1',
    });
  });

  it('검증 시도 횟수는 같은 창일 때만 HINCRBY로 올리고, 창이 없으면 null', async () => {
    redis.eval.mockResolvedValueOnce(3).mockResolvedValueOnce(null);

    await expect(store.increaseVerifyAttemptCount('010', 'w1')).resolves.toBe(
      3,
    );
    await expect(
      store.increaseVerifyAttemptCount('010', 'w1'),
    ).resolves.toBeNull();
    expect(redis.eval).toHaveBeenCalledWith(
      IN_WINDOW_LUA,
      1,
      'sms:auth:010',
      'w1',
      'HINCRBY',
      'verifyAttemptCount',
      '1',
    );
  });

  it('인증 완료 표시는 같은 창일 때만 한다', async () => {
    redis.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(null);

    await expect(store.markVerified('010', 'w1')).resolves.toBe(true);
    await expect(store.markVerified('010', 'w1')).resolves.toBe(false);
  });
});

describe('SmsEventDedupeStore', () => {
  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    exists: jest.fn(),
    del: jest.fn(),
  };
  const store = new SmsEventDedupeStore(redis as unknown as Redis);

  beforeEach(() => jest.resetAllMocks());

  it('claim은 5분짜리 processing 리스를 SET NX로 선점하면 claimed', async () => {
    redis.set.mockResolvedValueOnce('OK');

    await expect(store.claim('e1')).resolves.toBe('claimed');
    expect(redis.set).toHaveBeenCalledWith(
      'sms:event:e1',
      'processing',
      'EX',
      300,
      'NX',
    );
  });

  it('선점에 실패하면 완료 마커가 있으면 done, 아니면 in-progress', async () => {
    redis.set.mockResolvedValue(null);
    redis.get
      .mockResolvedValueOnce('done-v2')
      .mockResolvedValueOnce('processing');

    await expect(store.claim('e1')).resolves.toBe('done');
    await expect(store.claim('e1')).resolves.toBe('in-progress');
  });

  it('기존 HTTP 발송 완료 마커는 이벤트 발행 대상과 구분한다', async () => {
    redis.set.mockResolvedValue(null);
    redis.get.mockResolvedValue('done');

    await expect(store.claim('e1')).resolves.toBe('legacy-done');
  });

  it('발행 여부는 별도 키(sms:event-published)로 기록하고 조회한다', async () => {
    redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(store.isPublished('e1')).resolves.toBe(true);
    await expect(store.isPublished('e1')).resolves.toBe(false);
    await store.markPublished('e1');
    expect(redis.exists).toHaveBeenCalledWith('sms:event-published:e1');
    expect(redis.set).toHaveBeenCalledWith(
      'sms:event-published:e1',
      '1',
      'EX',
      604800,
    );
  });

  it('SET NX 직후 키가 사라졌다면(GET이 null) 한 번 더 선점을 시도한다', async () => {
    redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    redis.get.mockResolvedValueOnce(null);

    await expect(store.claim('e1')).resolves.toBe('claimed');
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('두 번 모두 상태를 읽지 못하면 in-progress로 본다 (던져서 재전달)', async () => {
    redis.set.mockResolvedValue(null);
    redis.get.mockResolvedValue(null);

    await expect(store.claim('e1')).resolves.toBe('in-progress');
  });

  it('clearFailureCount는 실패 카운터 키를 지운다', async () => {
    await store.clearFailureCount('e1');

    expect(redis.del).toHaveBeenCalledWith('sms:event-fail:e1');
  });

  it('complete는 7일짜리 done 마커로 덮어쓴다 (DLQ 수동 재처리 대비)', async () => {
    await store.complete('e1');

    expect(redis.set).toHaveBeenCalledWith(
      'sms:event:e1',
      'done-v2',
      'EX',
      604800,
    );
  });

  it('실패 횟수는 INCR로 올리고 TTL은 최초 1회만 건다', async () => {
    const multiChain = {
      incr: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, 3],
        [null, 0],
      ]),
    };
    const dedupe = new SmsEventDedupeStore({
      multi: () => multiChain,
    } as unknown as Redis);

    await expect(dedupe.increaseFailureCount('e1')).resolves.toBe(3);
    expect(multiChain.incr).toHaveBeenCalledWith('sms:event-fail:e1');
    expect(multiChain.expire).toHaveBeenCalledWith(
      'sms:event-fail:e1',
      604800,
      'NX',
    );
  });

  it('release는 키를 지운다', async () => {
    await store.release('e1');

    expect(redis.del).toHaveBeenCalledWith('sms:event:e1');
  });

  it('SENDING/UNKNOWN은 완료 마커와 같은 7일 동안 남겨 선점 만료·재시작 뒤에도 재발송을 막는다', async () => {
    await store.markSending('e1');
    await store.markUnknown('e1');

    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'sms:event:e1',
      'sending',
      'EX',
      604800,
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      'sms:event:e1',
      'unknown',
      'EX',
      604800,
    );
  });

  it('SENDING/UNKNOWN이 남은 이벤트의 선점은 unknown이다 (처리 중 대기와 구분)', async () => {
    redis.set.mockResolvedValue(null);
    redis.get.mockResolvedValueOnce('sending').mockResolvedValueOnce('unknown');

    await expect(store.claim('e1')).resolves.toBe('unknown');
    await expect(store.claim('e1')).resolves.toBe('unknown');
  });
});
