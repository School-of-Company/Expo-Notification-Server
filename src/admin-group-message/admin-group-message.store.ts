import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  GroupMessageRetryError,
  parseGroupMessageJob,
  parseGroupMessagePreviewRecord,
  type CreateGroupMessagePreview,
  type GroupMessageJob,
  type GroupMessagePreviewRecord,
} from './admin-group-message.schema';
import {
  groupMessageHistoryMutation,
  groupMessageTerminalHistoryType,
} from './admin-group-message-history.store';
import {
  createGroupMessageJobLua,
  groupMessageDeltaKey as deltaKey,
  groupMessageJobId,
  groupMessageJobKey as jobKey,
  groupMessageLockKey as lockKey,
  groupMessageQueueKey as queueKey,
  groupMessageRetryOperationKey as retryOperationKey,
  readGroupMessageJobLua,
  remainingGroupMessageJobTtl,
  saveGroupMessageJobLua,
  saveGroupMessageTargetLua,
  saveGroupMessageRetryLua,
} from './admin-group-message-job.scripts';

const previewKey = (id: string) => `admin-group-message:{jobs}:preview:${id}`;
const previewRequestKey = (id: string) =>
  `admin-group-message:{jobs}:preview-request:${id}`;
const previewTombstoneKey = (id: string) =>
  `admin-group-message:{jobs}:preview-tombstone:${id}`;
export { groupMessageJobId };

@Injectable()
export class AdminGroupMessageStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createPreview(
    input: CreateGroupMessagePreview,
  ): Promise<GroupMessagePreviewRecord | null> {
    const settings = this.config.adminGroupMessaging;
    if (!settings) throw new GroupMessageRetryError();
    const previewId = randomUUID();
    const now = new Date();
    const record: GroupMessagePreviewRecord = {
      ...input,
      previewId,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + settings.previewTtlSeconds * 1000,
      ).toISOString(),
    };
    const result = await this.eval(
      `
      local existing = redis.call('GET', KEYS[2])
      if existing then return existing end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
      redis.call('SET', KEYS[3], '1', 'EX', ARGV[4])
      return ARGV[3]`,
      3,
      previewKey(previewId),
      previewRequestKey(input.requestId),
      previewTombstoneKey(previewId),
      JSON.stringify(record),
      settings.previewTtlSeconds,
      previewId,
      settings.retentionSeconds,
    );
    return this.getPreview(String(result));
  }

  async getPreview(id: string): Promise<GroupMessagePreviewRecord | null> {
    const raw = await this.redis.get(previewKey(id));
    if (!raw) return null;
    return parseGroupMessagePreviewRecord(raw);
  }

  async isKnownPreview(id: string): Promise<boolean> {
    return (await this.redis.exists(previewTombstoneKey(id))) === 1;
  }

  async createJob(
    preview: GroupMessagePreviewRecord,
  ): Promise<GroupMessageJob> {
    const settings = this.config.adminGroupMessaging;
    if (!settings) throw new GroupMessageRetryError();
    const jobId = groupMessageJobId(preview.previewId);
    const now = new Date();
    const job: GroupMessageJob = {
      jobId,
      previewId: preview.previewId,
      requesterUserId: preview.requesterUserId,
      expoId: preview.expoId,
      applicationCount: preview.applicationCount,
      targetFingerprint: preview.targetFingerprint,
      channel: preview.channel,
      templateId: preview.templateId,
      fallbackToSms: preview.fallbackToSms,
      status: 'QUEUED',
      createdAt: now.toISOString(),
      authorizedUntil: new Date(
        now.getTime() + settings.authorizationTtlSeconds * 1000,
      ).toISOString(),
      targets: preview.targets.map((target) => ({
        ...target,
        status: target.missingReason ? 'MISSING' : 'PENDING',
      })),
    };
    const history = groupMessageHistoryMutation(
      job,
      'REQUESTED',
      settings.retentionSeconds,
    );
    await this.eval(
      createGroupMessageJobLua,
      6,
      jobKey(jobId),
      jobKey(jobId),
      queueKey,
      ...history.keys,
      '',
      JSON.stringify(job),
      settings.retentionSeconds,
      Date.now(),
      jobId,
      ...history.arguments,
    );
    const saved = await this.getJob(jobId);
    if (!saved) throw new GroupMessageRetryError();
    return saved;
  }

  async getJob(id: string): Promise<GroupMessageJob | null> {
    const result = await this.eval(
      readGroupMessageJobLua,
      2,
      jobKey(id),
      deltaKey(id),
    );
    const [raw, delta] = Array.isArray(result)
      ? (result as [string | null, string[]])
      : [null, []];
    if (!raw) return null;
    return parseGroupMessageJob(raw, delta);
  }

  getJobForPreview(previewId: string): Promise<GroupMessageJob | null> {
    return this.getJob(groupMessageJobId(previewId));
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    try {
      return (await this.redis.set(lockKey(id), token, 'EX', 30, 'NX')) === 'OK'
        ? token
        : null;
    } catch {
      throw new GroupMessageRetryError();
    }
  }

  // 대상 1명분 상태만 쓴다. 본문은 다음 save에서 증분과 함께 합쳐진다.
  async saveTarget(
    jobId: string,
    token: string,
    target: GroupMessageJob['targets'][number],
  ): Promise<void> {
    const result = await this.eval(
      saveGroupMessageTargetLua,
      3,
      jobKey(jobId),
      lockKey(jobId),
      deltaKey(jobId),
      token,
      target.targetId,
      JSON.stringify(target),
    );
    if (result !== 1) throw new GroupMessageRetryError();
  }

  async save(
    job: GroupMessageJob,
    token: string,
    dueAt?: number,
  ): Promise<void> {
    const settings = this.config.adminGroupMessaging;
    if (!settings) throw new GroupMessageRetryError();
    const due = dueAt ?? this.nextDue(job);
    const historyType = groupMessageTerminalHistoryType(job);
    const history = groupMessageHistoryMutation(
      job,
      historyType ?? 'SENT',
      settings.retentionSeconds,
    );
    const result = await this.eval(
      saveGroupMessageJobLua,
      7,
      jobKey(job.jobId),
      lockKey(job.jobId),
      queueKey,
      ...history.keys,
      deltaKey(job.jobId),
      token,
      JSON.stringify(job),
      remainingGroupMessageJobTtl(job, settings.retentionSeconds),
      due,
      job.jobId,
      ...history.arguments.slice(0, 3),
      historyType ?? '',
    );
    if (result !== 1) throw new GroupMessageRetryError();
  }

  async saveRetry(
    job: GroupMessageJob,
    token: string,
    operationId: string,
  ): Promise<boolean> {
    const settings = this.config.adminGroupMessaging;
    if (!settings) throw new GroupMessageRetryError();
    const history = groupMessageHistoryMutation(
      job,
      'RETRIED',
      settings.retentionSeconds,
    );
    const result = await this.eval(
      saveGroupMessageRetryLua,
      8,
      jobKey(job.jobId),
      lockKey(job.jobId),
      queueKey,
      ...history.keys,
      retryOperationKey(job.jobId, operationId),
      deltaKey(job.jobId),
      token,
      JSON.stringify(job),
      remainingGroupMessageJobTtl(job, settings.retentionSeconds),
      Date.now(),
      job.jobId,
      ...history.arguments,
    );
    if (result === 0) throw new GroupMessageRetryError();
    return result === 1;
  }

  async release(id: string, token: string): Promise<void> {
    await this.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lockKey(id),
      token,
    );
  }

  due(): Promise<string[]> {
    return this.redis.zrangebyscore(queueKey, 0, Date.now(), 'LIMIT', 0, 100);
  }

  async removeDue(id: string): Promise<void> {
    await this.redis.zrem(queueKey, id);
  }

  private async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    try {
      return await this.redis.eval(script, numberOfKeys, ...args);
    } catch {
      throw new GroupMessageRetryError();
    }
  }

  private nextDue(job: GroupMessageJob): number {
    if (
      job.targets.some(
        (target) => target.status === 'PENDING' || target.status === 'SENDING',
      )
    )
      return Date.now();
    if (job.targets.some((target) => target.status === 'ACCEPTED'))
      return Date.now() + 30_000;
    return 0;
  }
}
