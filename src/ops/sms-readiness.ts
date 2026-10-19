import { readFileSync } from 'node:fs';
import { AppConfig } from '../config/app-config';
import {
  SMS_EVENT_DONE_MARKER,
  SMS_EVENT_DONE_TTL_SECONDS,
} from '../sms/sms-event-dedupe.store';

/**
 * 연수 CUSTOM 운영 준비 점검(#27). 운영 Kafka/Redis를 읽기만 한다.
 * - Kafka: 토픽 목록·메타데이터, group 상태, committed offset, high watermark만 조회한다.
 *   (없는 토픽은 메타데이터를 요청하지 않는다 — 자동 생성이 켜진 broker에서 토픽이 생기지 않게.)
 * - Redis: INFO만 실행한다. key 값/목록은 읽지 않는다.
 * 비밀값·전화번호·본문은 출력하지 않는다.
 */

export type ReleaseManifest = {
  sha: string;
  release?: string;
  runId?: string;
  runAttempt?: string;
  runUrl?: string;
  builtAt?: string;
};

export type PartitionOffset = {
  partition: number;
  committed: string | null;
  logEnd: string;
  lag: string | null;
};

export type ReadinessSnapshot = {
  checkedAt: string;
  release: ReleaseManifest | null;
  sms: {
    doneMarker: string;
    doneTtlSeconds: number;
    eventMaxAttempts: number;
    traineeSenderConfigured: boolean;
    /** sms.apiBaseUrl이 설정됐을 때 호스트만. 전체 URL(경로·자격 증명)은 담지 않는다. */
    apiBaseUrlHost: string | null;
  };
  kafka: {
    groupId: string;
    topics: Record<
      'smsRequested' | 'smsDeadLetter' | 'qrSmsSent',
      { name: string; exists: boolean; partitions: number | null }
    >;
    group: { state: string; members: number } | null;
    requestedOffsets: PartitionOffset[] | null;
    error?: string;
  };
  redis: {
    role?: string;
    aofEnabled?: boolean;
    aofLastWriteStatus?: string;
    rdbLastBgsaveStatus?: string;
    rdbLastSaveTime?: string;
    maxmemoryPolicy?: string;
    error?: string;
  };
};

export type CheckStatus = 'ok' | 'fail' | 'manual';

export type ReadinessCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type ReadinessReport = ReadinessSnapshot & {
  checks: ReadinessCheck[];
  ready: boolean;
};

/** 문서에 합의된 완료 마커 보존 기간(완료 시점부터 7일). */
export const EXPECTED_DONE_TTL_SECONDS = 604800;

export interface ReadinessKafkaAdmin {
  listTopics(): Promise<string[]>;
  fetchTopicMetadata(options: {
    topics: string[];
  }): Promise<{ topics: Array<{ name: string; partitions: unknown[] }> }>;
  describeGroups(
    groupIds: string[],
  ): Promise<{ groups: Array<{ state: string; members: unknown[] }> }>;
  fetchOffsets(options: { groupId: string; topics: string[] }): Promise<
    Array<{
      topic: string;
      partitions: Array<{ partition: number; offset: string }>;
    }>
  >;
  fetchTopicOffsets(
    topic: string,
  ): Promise<Array<{ partition: number; high: string }>>;
}

export interface ReadinessRedis {
  info(section: string): Promise<string>;
}

export function readReleaseManifest(path: string): ReleaseManifest | null {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { sha?: unknown }).sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test((body as { sha: string }).sha)
  ) {
    return null;
  }
  const pick = (field: keyof ReleaseManifest) => {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    sha: (body as { sha: string }).sha,
    release: pick('release'),
    runId: pick('runId'),
    runAttempt: pick('runAttempt'),
    runUrl: pick('runUrl'),
    builtAt: pick('builtAt'),
  };
}

export function parseRedisInfo(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf(':');
    if (index > 0) {
      fields[line.slice(0, index)] = line.slice(index + 1).trim();
    }
  }
  return fields;
}

function hostOnly(url: string): string {
  try {
    return new URL(url).host || '(호스트 없음)';
  } catch {
    return '(해석 불가)';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectKafka(
  config: AppConfig,
  admin: ReadinessKafkaAdmin,
): Promise<ReadinessSnapshot['kafka']> {
  const groupId = config.kafka.smsGroupId;
  const names = {
    smsRequested: config.kafka.topics.smsRequested,
    smsDeadLetter: config.kafka.topics.smsDeadLetter,
    qrSmsSent: config.kafka.topics.qrSmsSent,
  };
  const topics = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [
      key,
      { name, exists: false, partitions: null },
    ]),
  ) as ReadinessSnapshot['kafka']['topics'];
  const result: ReadinessSnapshot['kafka'] = {
    groupId,
    topics,
    group: null,
    requestedOffsets: null,
  };
  try {
    const existing = new Set(await admin.listTopics());
    const present = Object.values(names).filter((name) => existing.has(name));
    const metadata = present.length
      ? (await admin.fetchTopicMetadata({ topics: present })).topics
      : [];
    for (const topic of Object.values(topics)) {
      const found = metadata.find((entry) => entry.name === topic.name);
      topic.exists = found !== undefined;
      topic.partitions = found ? found.partitions.length : null;
    }

    const [group] = (await admin.describeGroups([groupId])).groups;
    result.group = group
      ? { state: group.state, members: group.members.length }
      : null;

    if (topics.smsRequested.exists) {
      const [committed] = await admin.fetchOffsets({
        groupId,
        topics: [names.smsRequested],
      });
      const ends = await admin.fetchTopicOffsets(names.smsRequested);
      result.requestedOffsets = ends
        .map(({ partition, high }) => {
          const offset = committed?.partitions.find(
            (entry) => entry.partition === partition,
          )?.offset;
          const has = offset !== undefined && Number(offset) >= 0;
          return {
            partition,
            committed: has ? offset : null,
            logEnd: high,
            lag: has ? String(BigInt(high) - BigInt(offset)) : null,
          };
        })
        .sort((a, b) => a.partition - b.partition);
    }
  } catch (error) {
    result.error = errorMessage(error);
  }
  return result;
}

async function collectRedis(
  redis: ReadinessRedis,
): Promise<ReadinessSnapshot['redis']> {
  try {
    const fields = {
      ...parseRedisInfo(await redis.info('replication')),
      ...parseRedisInfo(await redis.info('persistence')),
      ...parseRedisInfo(await redis.info('memory')),
    };
    return {
      role: fields.role,
      aofEnabled:
        fields.aof_enabled === undefined
          ? undefined
          : fields.aof_enabled === '1',
      aofLastWriteStatus: fields.aof_last_write_status,
      rdbLastBgsaveStatus: fields.rdb_last_bgsave_status,
      rdbLastSaveTime:
        fields.rdb_last_save_time && Number(fields.rdb_last_save_time) > 0
          ? new Date(Number(fields.rdb_last_save_time) * 1000).toISOString()
          : undefined,
      maxmemoryPolicy: fields.maxmemory_policy,
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function collectReadiness(
  config: AppConfig,
  deps: {
    admin: ReadinessKafkaAdmin;
    redis: ReadinessRedis;
    release: ReleaseManifest | null;
    now?: () => Date;
  },
): Promise<ReadinessSnapshot> {
  const [kafka, redis] = await Promise.all([
    collectKafka(config, deps.admin),
    collectRedis(deps.redis),
  ]);
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    release: deps.release,
    sms: {
      doneMarker: SMS_EVENT_DONE_MARKER,
      doneTtlSeconds: SMS_EVENT_DONE_TTL_SECONDS,
      eventMaxAttempts: config.sms.eventMaxAttempts,
      traineeSenderConfigured: config.sms.fromTraineeNumber.trim().length > 0,
      apiBaseUrlHost: config.sms.apiBaseUrl
        ? hostOnly(config.sms.apiBaseUrl)
        : null,
    },
    kafka,
    redis,
  };
}

function topicCheck(
  snapshot: ReadinessSnapshot,
  key: keyof ReadinessSnapshot['kafka']['topics'],
): ReadinessCheck {
  const topic = snapshot.kafka.topics[key];
  if (snapshot.kafka.error) {
    return {
      name: `kafka.topic.${key}`,
      status: 'fail',
      detail: `조회 실패: ${snapshot.kafka.error}`,
    };
  }
  return topic.exists
    ? {
        name: `kafka.topic.${key}`,
        status: 'ok',
        detail: `${topic.name} partitions=${topic.partitions}`,
      }
    : {
        name: `kafka.topic.${key}`,
        status: 'fail',
        detail: `${topic.name} 없음`,
      };
}

export function evaluateReadiness(
  snapshot: ReadinessSnapshot,
): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const { kafka, redis, sms, release } = snapshot;

  checks.push(
    release
      ? {
          name: 'release.sha',
          status: 'ok',
          detail: `${release.sha}${release.runUrl ? ` (${release.runUrl})` : ''}`,
        }
      : {
          name: 'release.sha',
          status: 'manual',
          detail:
            'release.json 없음 — 배포 workflow 기록과 PM2 실행 경로로 SHA를 대조한다',
        },
  );

  checks.push(
    sms.doneTtlSeconds === EXPECTED_DONE_TTL_SECONDS &&
      sms.doneMarker === 'done-v2'
      ? {
          name: 'sms.doneMarkerTtl',
          status: 'ok',
          detail: `${sms.doneMarker} ${sms.doneTtlSeconds}s`,
        }
      : {
          name: 'sms.doneMarkerTtl',
          status: 'fail',
          detail: `${sms.doneMarker} ${sms.doneTtlSeconds}s (기대 done-v2 ${EXPECTED_DONE_TTL_SECONDS}s)`,
        },
  );

  checks.push(
    sms.traineeSenderConfigured
      ? {
          name: 'sms.traineeSender',
          status: 'manual',
          detail: '설정됨(값 비공개) — 승인된 연수 발신번호인지 담당자가 확인',
        }
      : {
          name: 'sms.traineeSender',
          status: 'fail',
          detail: '연수 발신번호 미설정',
        },
  );

  // 이 도구는 운영 artifact에서 서비스와 같은 설정으로 돌리므로, 값이 있으면 운영에 남은 것으로 보고 fail로 본다.
  checks.push(
    sms.apiBaseUrlHost === null
      ? {
          name: 'sms.apiBaseUrl',
          status: 'ok',
          detail: '미설정 — 실제 Solapi로 발송',
        }
      : {
          name: 'sms.apiBaseUrl',
          status: 'fail',
          detail: `SMS_API_BASE_URL 설정됨(host=${sms.apiBaseUrlHost}) — 모든 Solapi 호출과 인증 헤더가 그 주소로 간다. 공동 연결 검증 전용이므로 운영에서는 제거한다`,
        },
  );

  checks.push(topicCheck(snapshot, 'smsRequested'));
  checks.push(topicCheck(snapshot, 'smsDeadLetter'));
  checks.push(topicCheck(snapshot, 'qrSmsSent'));

  if (!kafka.error) {
    const group = kafka.group;
    checks.push(
      group && group.state === 'Stable' && group.members > 0
        ? {
            name: 'kafka.group',
            status: 'ok',
            detail: `${kafka.groupId} Stable members=${group.members}`,
          }
        : {
            name: 'kafka.group',
            status: 'fail',
            detail: `${kafka.groupId} state=${group?.state ?? 'unknown'} members=${group?.members ?? 0} — consumer가 구독 중이 아니다`,
          },
    );

    const offsets = kafka.requestedOffsets;
    const missing = (offsets ?? []).filter((entry) => entry.committed === null);
    checks.push(
      offsets && offsets.length > 0 && missing.length === 0
        ? {
            name: 'kafka.committedOffsets',
            status: 'ok',
            detail: offsets
              .map((entry) => `p${entry.partition}=lag ${entry.lag}`)
              .join(', '),
          }
        : {
            name: 'kafka.committedOffsets',
            status: 'fail',
            detail: offsets
              ? `committed offset 없는 partition: ${missing.map((entry) => entry.partition).join(', ') || '(partition 없음)'} — fromBeginning:false라 첫 구독 전 메시지는 건너뛴다`
              : '요청 topic이 없어 offset을 조회하지 않았다',
          },
    );
  }

  if (redis.error) {
    checks.push({
      name: 'redis.info',
      status: 'fail',
      detail: `INFO 실패: ${redis.error}`,
    });
  } else {
    checks.push(
      redis.maxmemoryPolicy === 'noeviction'
        ? {
            name: 'redis.maxmemoryPolicy',
            status: 'ok',
            detail: 'noeviction',
          }
        : {
            name: 'redis.maxmemoryPolicy',
            status: 'fail',
            detail: `${redis.maxmemoryPolicy ?? 'unknown'} — 메모리 부족 시 완료 마커가 지워져 중복 발송될 수 있다`,
          },
    );
    checks.push({
      name: 'redis.persistence',
      status: 'manual',
      detail: `aof=${redis.aofEnabled ?? 'unknown'} aofLastWrite=${redis.aofLastWriteStatus ?? 'unknown'} rdbLastBgsave=${redis.rdbLastBgsaveStatus ?? 'unknown'} — 백업/복구 절차와 최근 복구 검증은 담당자가 확인`,
    });
  }

  checks.push({
    name: 'kafka.acl',
    status: 'manual',
    detail:
      '메타데이터 조회 성공은 요청 topic/group READ, DLQ WRITE 권한을 증명하지 않는다 — 기존 ACL 기록과 대조',
  });

  return {
    ...snapshot,
    checks,
    ready: checks.every((check) => check.status !== 'fail'),
  };
}
