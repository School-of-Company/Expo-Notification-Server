import {
  auditPromotionLedger,
  evaluateRedisReadiness,
} from './promotion-audit';
import type { PromotionRecord } from './promotion.schema';

const event = (n: number) => ({
  version: 1 as const,
  eventId: `00000000-0000-4000-8000-00000000000${n}`,
  applicationId: '22222222-2222-4222-8222-222222222222',
  expoId: '33333333-3333-4333-8333-333333333333',
  participantId: 1,
  programType: 'STANDARD' as const,
  programId: 2,
});
const record = (
  n: number,
  status: PromotionRecord['status'],
  extra: Partial<PromotionRecord> = {},
): PromotionRecord => ({ event: event(n), status, failures: 0, ...extra });
const entry = (r: PromotionRecord, ttl = -1) => ({
  id: r.event.eventId,
  ttl,
  record: r,
});

describe('auditPromotionLedger', () => {
  it('대조 대상, TTL, due 정합성을 분류한다', () => {
    const attempt = '44444444-4444-4444-8444-444444444444';
    const records = [
      record(1, 'PENDING'),
      record(2, 'SENDING', {
        attemptId: attempt,
        attemptedAt: '2026-10-01T00:00:01.000Z',
      }),
      record(3, 'UNKNOWN', {
        attemptId: attempt,
        attemptedAt: '2026-10-01T00:00:00.000Z',
      }),
      record(4, 'ACCEPTED', { messageId: 'm-4' }),
      record(5, 'OPERATIONS'),
      record(6, 'DELIVERED'),
      record(7, 'PENDING', { attemptId: attempt }),
    ];
    const audit = auditPromotionLedger({
      records: [
        ...records.map((r, i) => entry(r, i === 5 ? 100 : -1)),
        { id: 'broken', ttl: -1, record: null },
      ],
      due: [
        { id: event(1).eventId, score: 1 },
        { id: event(7).eventId, score: 1 },
        { id: event(6).eventId, score: 1 },
        { id: 'ghost', score: 1 },
      ],
      dueTotal: 4,
      dueTtl: -1,
      truncated: false,
    });

    expect(audit.byStatus).toMatchObject({
      PENDING: 2,
      SENDING: 1,
      UNKNOWN: 1,
    });
    expect(audit.invalid).toEqual(['broken']);
    expect(audit.withTtl).toEqual([event(6).eventId]);
    expect(audit.reconcile.map((i) => [i.status, i.action])).toEqual([
      ['ACCEPTED', 'RECONCILE_BY_MESSAGE_ID'],
      ['OPERATIONS', 'OPERATIONS_REVIEW'],
      ['PENDING', 'VERIFY_PRIOR_ATTEMPT'],
      ['UNKNOWN', 'PROVIDER_LOOKUP_BY_ATTEMPT'],
      ['SENDING', 'PROVIDER_LOOKUP_BY_ATTEMPT'],
    ]);
    expect(audit.notScheduled).toEqual([event(4).eventId]);
    expect(audit.unexpectedDue).toEqual([event(6).eventId]);
    expect(audit.dueWithoutRecord).toEqual(['ghost']);
  });
});

describe('evaluateRedisReadiness', () => {
  const persistence = {
    aof_enabled: '1',
    aof_last_write_status: 'ok',
    rdb_last_bgsave_status: 'ok',
    loading: '0',
  };

  it('AOF·noeviction·TTL 없음이면 PASS', () => {
    const readiness = evaluateRedisReadiness(
      { appendonly: 'yes', maxmemoryPolicy: 'noeviction', persistence },
      { dueTtl: -1, withTtl: 0 },
    );
    expect(readiness.result).toBe('PASS');
    expect(readiness.manual.length).toBeGreaterThan(0);
  });

  it('eviction 정책이나 TTL이 있으면 FAIL', () => {
    expect(
      evaluateRedisReadiness(
        { appendonly: 'yes', maxmemoryPolicy: 'allkeys-lru', persistence },
        { dueTtl: -1, withTtl: 0 },
      ).result,
    ).toBe('FAIL');
    expect(
      evaluateRedisReadiness(
        { appendonly: 'yes', maxmemoryPolicy: 'noeviction', persistence },
        { dueTtl: 60, withTtl: 0 },
      ).result,
    ).toBe('FAIL');
  });

  it('CONFIG/INFO가 막혀 있으면 실패로 위장하지 않고 UNVERIFIED', () => {
    const readiness = evaluateRedisReadiness(
      { appendonly: null, maxmemoryPolicy: null, persistence: null },
      { dueTtl: -2, withTtl: 0 },
    );
    expect(readiness.result).toBe('UNVERIFIED');
  });
});
