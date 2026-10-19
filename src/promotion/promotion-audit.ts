import type { PromotionRecord } from './promotion.schema';
import type {
  PromotionLedgerSnapshot,
  PromotionRedisSettings,
} from './promotion.store';

// #32 승급 원장 운영 점검. I/O 없는 순수 함수이고 번호·이름·본문은 원장에 없으므로 결과에도 없다.

type Status = PromotionRecord['status'];
export type PromotionReconcileAction =
  // messageId가 있다: POST :eventId/reconciliation 으로 공급자 결과를 대조한다.
  | 'RECONCILE_BY_MESSAGE_ID'
  // messageId가 없다: 공급자 콘솔/지원에서 eventId+attemptId(customFields)와 시도 시각으로 찾는다.
  | 'PROVIDER_LOOKUP_BY_ATTEMPT'
  // 번호 없음·본문 초과·5회 실패: 원인 확인 후 승인된 수동 재개만 한다.
  | 'OPERATIONS_REVIEW'
  // 이전 시도가 있는 PENDING: 복구본이 오래된 경우 이후 시도가 공급자에 있을 수 있다.
  | 'VERIFY_PRIOR_ATTEMPT';

export type PromotionReconcileItem = {
  readonly eventId: string;
  readonly status: Status;
  readonly action: PromotionReconcileAction;
  readonly failures: number;
  readonly attemptId?: string;
  readonly attemptedAt?: string;
  readonly messageId?: string;
  readonly reason?: string;
};

export type PromotionLedgerAudit = {
  readonly total: number;
  readonly truncated: boolean;
  readonly byStatus: Record<Status, number>;
  readonly invalid: string[];
  readonly withTtl: string[];
  readonly reconcile: PromotionReconcileItem[];
  readonly dueTotal: number;
  readonly dueWithoutRecord: string[];
  readonly notScheduled: string[];
  readonly unexpectedDue: string[];
};

const REPORT_LIMIT = 500;

function actionFor(record: PromotionRecord): PromotionReconcileAction | null {
  switch (record.status) {
    case 'SENDING':
    case 'UNKNOWN':
      return record.messageId
        ? 'RECONCILE_BY_MESSAGE_ID'
        : 'PROVIDER_LOOKUP_BY_ATTEMPT';
    case 'ACCEPTED':
      return 'RECONCILE_BY_MESSAGE_ID';
    case 'OPERATIONS':
      return 'OPERATIONS_REVIEW';
    case 'PENDING':
      return record.attemptId ? 'VERIFY_PRIOR_ATTEMPT' : null;
    case 'DELIVERED':
    case 'SKIPPED':
      return null;
    default: {
      const exhaustive: never = record.status;
      return exhaustive;
    }
  }
}

export function auditPromotionLedger(
  snapshot: PromotionLedgerSnapshot,
): PromotionLedgerAudit {
  const byStatus: Record<Status, number> = {
    PENDING: 0,
    SENDING: 0,
    UNKNOWN: 0,
    ACCEPTED: 0,
    DELIVERED: 0,
    SKIPPED: 0,
    OPERATIONS: 0,
  };
  const invalid: string[] = [];
  const withTtl: string[] = [];
  const reconcile: PromotionReconcileItem[] = [];
  const notScheduled: string[] = [];
  const unexpectedDue: string[] = [];
  const due = new Set(snapshot.due.map((entry) => entry.id));
  const known = new Set<string>();
  for (const { id, ttl, record } of snapshot.records) {
    known.add(id);
    if (ttl !== -1) withTtl.push(id);
    if (!record) {
      invalid.push(id);
      continue;
    }
    byStatus[record.status] += 1;
    const scheduled =
      record.status === 'PENDING' || record.status === 'ACCEPTED';
    if (scheduled && !due.has(id)) notScheduled.push(id);
    if (!scheduled && due.has(id)) unexpectedDue.push(id);
    const action = actionFor(record);
    if (action)
      reconcile.push({
        eventId: id,
        status: record.status,
        action,
        failures: record.failures,
        attemptId: record.attemptId,
        attemptedAt: record.attemptedAt,
        messageId: record.messageId,
        reason: record.reason,
      });
  }
  // 오래된 시도부터 대조한다.
  reconcile.sort((a, b) =>
    (a.attemptedAt ?? '').localeCompare(b.attemptedAt ?? ''),
  );
  return {
    total: snapshot.records.length,
    truncated: snapshot.truncated || reconcile.length > REPORT_LIMIT,
    byStatus,
    invalid: invalid.slice(0, REPORT_LIMIT),
    withTtl: withTtl.slice(0, REPORT_LIMIT),
    reconcile: reconcile.slice(0, REPORT_LIMIT),
    dueTotal: snapshot.dueTotal,
    dueWithoutRecord: snapshot.truncated
      ? []
      : snapshot.due
          .filter((entry) => !known.has(entry.id))
          .map((entry) => entry.id)
          .slice(0, REPORT_LIMIT),
    notScheduled: notScheduled.slice(0, REPORT_LIMIT),
    unexpectedDue: unexpectedDue.slice(0, REPORT_LIMIT),
  };
}

export type RedisCheckResult = 'PASS' | 'FAIL' | 'UNVERIFIED';
export type RedisCheck = {
  readonly name: string;
  readonly result: RedisCheckResult;
  readonly observed: string | null;
};
export type RedisReadiness = {
  readonly result: RedisCheckResult;
  readonly checks: RedisCheck[];
  // 서버 안에서 확인할 수 없어 운영 담당자가 증거를 남겨야 하는 항목.
  readonly manual: string[];
};

export function evaluateRedisReadiness(
  settings: PromotionRedisSettings,
  ledger: { readonly dueTtl: number; readonly withTtl: number },
): RedisReadiness {
  const info = settings.persistence;
  const aof =
    settings.appendonly ??
    (info?.aof_enabled === undefined
      ? null
      : info.aof_enabled === '1'
        ? 'yes'
        : 'no');
  const check = (
    name: string,
    observed: string | null | undefined,
    pass: (value: string) => boolean,
  ): RedisCheck => ({
    name,
    observed: observed ?? null,
    result:
      observed === null || observed === undefined
        ? 'UNVERIFIED'
        : pass(observed)
          ? 'PASS'
          : 'FAIL',
  });
  const checks: RedisCheck[] = [
    check('AOF_ENABLED', aof, (value) => value === 'yes'),
    check('AOF_LAST_WRITE_OK', info?.aof_last_write_status, (value) =>
      aof === 'yes' ? value === 'ok' : true,
    ),
    check(
      'RDB_LAST_BGSAVE_OK',
      info?.rdb_last_bgsave_status,
      (value) => value === 'ok',
    ),
    check(
      'MAXMEMORY_POLICY_NOEVICTION',
      settings.maxmemoryPolicy,
      (value) => value === 'noeviction',
    ),
    check('NOT_LOADING', info?.loading, (value) => value === '0'),
    {
      name: 'LEDGER_NO_TTL',
      // -2: due ZSET이 아직 없다(빈 원장).
      observed: `dueTtl=${ledger.dueTtl},recordsWithTtl=${ledger.withTtl}`,
      result:
        (ledger.dueTtl === -1 || ledger.dueTtl === -2) && ledger.withTtl === 0
          ? 'PASS'
          : 'FAIL',
    },
  ];
  const result: RedisCheckResult = checks.some((c) => c.result === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.result === 'UNVERIFIED')
      ? 'UNVERIFIED'
      : 'PASS';
  return {
    result,
    checks,
    manual: [
      'BACKUP_SCHEDULE_AND_RESTORE_DRILL',
      'NETWORK_AND_ACL_RESTRICTION',
      'RESTORE_POLICY_PROVIDER_RECONCILIATION_BEFORE_BACKLOG',
    ],
  };
}
