import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  groupMessageHistoryEventSchema,
  type GroupMessageHistoryEvent,
  type GroupMessageHistoryQuery,
  type GroupMessageHistoryType,
} from './admin-group-message-history.schema';
import type { GroupMessageJob } from './admin-group-message.schema';

const historyIndexKey = (expoId: string, type?: GroupMessageHistoryType) =>
  `admin-group-message:{jobs}:history:${expoId}:${type ?? 'ALL'}`;
export const historyMarkerKey = (jobId: string) =>
  `admin-group-message:{jobs}:history-marker:${jobId}`;

export const appendHistoryLua = `
redis.call('ZREMRANGEBYLEX', KEYS[4], '-', ARGV[8])
redis.call('ZREMRANGEBYLEX', KEYS[5], '-', ARGV[8])
redis.call('ZADD', KEYS[4], 0, ARGV[6])
redis.call('ZADD', KEYS[5], 0, ARGV[6])
for index = 4, 5 do
  local expiresAt = redis.call('EXPIRETIME', KEYS[index])
  if expiresAt < tonumber(ARGV[7]) then
    redis.call('EXPIREAT', KEYS[index], ARGV[7])
  end
end
redis.call('HSET', KEYS[6], 'lastType', ARGV[9])
redis.call('EXPIRE', KEYS[6], ARGV[3])`;

export const validateHistoryKeysLua = `
if redis.call('TYPE', KEYS[4]).ok ~= 'none' and redis.call('TYPE', KEYS[4]).ok ~= 'zset' then
  return redis.error_reply('history index type invalid')
end
if redis.call('TYPE', KEYS[5]).ok ~= 'none' and redis.call('TYPE', KEYS[5]).ok ~= 'zset' then
  return redis.error_reply('history type index type invalid')
end
if redis.call('TYPE', KEYS[6]).ok ~= 'none' and redis.call('TYPE', KEYS[6]).ok ~= 'hash' then
  return redis.error_reply('history marker type invalid')
end`;

export type GroupMessageHistoryMutation = {
  readonly keys: readonly [string, string, string];
  readonly arguments: readonly [
    string,
    number,
    string,
    GroupMessageHistoryType,
  ];
};

export function groupMessageHistoryMutation(
  job: GroupMessageJob,
  type: GroupMessageHistoryType,
  retentionSeconds: number,
): GroupMessageHistoryMutation {
  const occurredAt = new Date();
  const eventId = randomUUID();
  const count = (
    statuses: ReadonlyArray<GroupMessageJob['targets'][number]['status']>,
  ) => job.targets.filter((target) => statuses.includes(target.status)).length;
  const event: GroupMessageHistoryEvent = {
    eventId,
    type,
    adminId: job.requesterUserId,
    occurredAt: occurredAt.toISOString(),
    targetScope: {
      kind: 'EXPLICIT_TARGETS',
      applicationCount: job.applicationCount ?? null,
      ...(job.targets[0]?.ledgerKey !== undefined
        ? { source: 'PREREGISTRATION' as const }
        : {}),
      programTypes: [
        ...new Set(
          job.targets.flatMap((target) =>
            target.programType ? [target.programType] : [],
          ),
        ),
      ].sort(),
    },
    counts: {
      total: job.targets.length,
      pending: count(['PENDING', 'SENDING']),
      accepted: count(['ACCEPTED']),
      delivered: count(['DELIVERED']),
      failed: count(['FAILED']),
      unknown: count(['UNKNOWN']),
      missing: count(['MISSING']),
    },
    status: job.status,
    jobId: job.jobId,
  };
  const timestamp = String(occurredAt.getTime()).padStart(13, '0');
  const cursor = `${timestamp}:${eventId}`;
  const expiresAt = Math.ceil(occurredAt.getTime() / 1000) + retentionSeconds;
  const cutoff = occurredAt.getTime() - retentionSeconds * 1000;
  return {
    keys: [
      historyIndexKey(job.expoId),
      historyIndexKey(job.expoId, type),
      historyMarkerKey(job.jobId),
    ],
    arguments: [
      `${cursor}|${Buffer.from(JSON.stringify(event)).toString('base64url')}`,
      expiresAt,
      `(${String(cutoff).padStart(13, '0')}:`,
      type,
    ],
  };
}

export function groupMessageTerminalHistoryType(
  job: GroupMessageJob,
): GroupMessageHistoryType | undefined {
  if (
    job.targets.some((target) =>
      ['PENDING', 'SENDING', 'ACCEPTED'].includes(target.status),
    )
  )
    return undefined;
  if (job.status === 'COMPLETED') return 'SENT';
  if (job.status === 'COMPLETED_WITH_FAILURES' || job.status === 'ATTENTION')
    return 'FAILED';
  return undefined;
}

@Injectable()
export class AdminGroupMessageHistoryStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(expoId: string, query: GroupMessageHistoryQuery) {
    const retentionSeconds = this.config.adminGroupMessaging?.retentionSeconds;
    if (!retentionSeconds)
      throw new Error('group message history is unavailable');
    const now = Date.now();
    const cutoff = now - retentionSeconds * 1000;
    const key = historyIndexKey(expoId, query.type);
    await this.redis.zremrangebylex(
      key,
      '-',
      `(${String(cutoff).padStart(13, '0')}:`,
    );
    const from = Math.max(
      cutoff,
      query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY,
    );
    const minimum = `[${String(from).padStart(13, '0')}:`;
    const upperBounds = [
      query.cursor ? `${query.cursor}|` : undefined,
      query.to
        ? `${String(Date.parse(query.to)).padStart(13, '0')}:`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    const maximum = upperBounds.length ? `(${upperBounds.sort()[0]}` : '+';
    const members = await this.redis.zrevrangebylex(
      key,
      maximum,
      minimum,
      'LIMIT',
      0,
      query.limit + 1,
    );
    const page = members.slice(0, query.limit);
    const items = page.map((member) => {
      const separator = member.indexOf('|');
      const payload: unknown = JSON.parse(
        Buffer.from(member.slice(separator + 1), 'base64url').toString(),
      );
      return groupMessageHistoryEventSchema.parse(payload);
    });
    return {
      items,
      nextCursor:
        members.length > query.limit
          ? page.at(-1)?.slice(0, page.at(-1)?.indexOf('|'))
          : undefined,
    };
  }
}
