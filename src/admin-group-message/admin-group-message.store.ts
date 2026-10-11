import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  groupMessageJobSchema,
  groupMessagePreviewRecordSchema,
  GroupMessageRetryError,
  type CreateGroupMessagePreview,
  type GroupMessageJob,
  type GroupMessagePreviewRecord,
} from './admin-group-message.schema';

const queueKey = 'admin-group-message:{jobs}:due';
const previewKey = (id: string) => `admin-group-message:{jobs}:preview:${id}`;
const previewRequestKey = (id: string) =>
  `admin-group-message:{jobs}:preview-request:${id}`;
const previewTombstoneKey = (id: string) =>
  `admin-group-message:{jobs}:preview-tombstone:${id}`;
const jobKey = (id: string) => `admin-group-message:{jobs}:job:${id}`;
const lockKey = (id: string) => `admin-group-message:{jobs}:lock:${id}`;
const retryOperationKey = (id: string, operationId: string) =>
  `admin-group-message:{jobs}:retry:${id}:${operationId}`;

export function groupMessageJobId(previewId: string): string {
  return createHash('sha256')
    .update(`admin-group-message:${previewId}`)
    .digest('hex');
}

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
    const result = await this.redis.eval(
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
    const body: unknown = JSON.parse(raw);
    return groupMessagePreviewRecordSchema.parse(body);
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
      targetFingerprint: preview.targetFingerprint,
      channel: preview.channel,
      templateId: preview.templateId,
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
    await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 0 then
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
        redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
      end
      return 1`,
      2,
      jobKey(jobId),
      queueKey,
      JSON.stringify(job),
      settings.retentionSeconds,
      Date.now(),
      jobId,
    );
    const saved = await this.getJob(jobId);
    if (!saved) throw new GroupMessageRetryError();
    return saved;
  }

  async getJob(id: string): Promise<GroupMessageJob | null> {
    const raw = await this.redis.get(jobKey(id));
    if (!raw) return null;
    const body: unknown = JSON.parse(raw);
    return groupMessageJobSchema.parse(body);
  }

  getJobForPreview(previewId: string): Promise<GroupMessageJob | null> {
    return this.getJob(groupMessageJobId(previewId));
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    return (await this.redis.set(lockKey(id), token, 'EX', 30, 'NX')) === 'OK'
      ? token
      : null;
  }

  async save(
    job: GroupMessageJob,
    token: string,
    dueAt?: number,
  ): Promise<void> {
    const settings = this.config.adminGroupMessaging;
    if (!settings) throw new GroupMessageRetryError();
    const due = dueAt ?? this.nextDue(job);
    const result = await this.redis.eval(
      `
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      if ARGV[4] == '0' then redis.call('ZREM', KEYS[3], ARGV[5])
      else redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5]) end
      return 1`,
      3,
      jobKey(job.jobId),
      lockKey(job.jobId),
      queueKey,
      token,
      JSON.stringify(job),
      this.remainingJobTtl(job, settings.retentionSeconds),
      due,
      job.jobId,
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
    const result = await this.redis.eval(
      `
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
      if redis.call('EXISTS', KEYS[4]) == 1 then return 2 end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      redis.call('SET', KEYS[4], '1', 'EX', ARGV[3])
      redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
      return 1`,
      4,
      jobKey(job.jobId),
      lockKey(job.jobId),
      queueKey,
      retryOperationKey(job.jobId, operationId),
      token,
      JSON.stringify(job),
      this.remainingJobTtl(job, settings.retentionSeconds),
      Date.now(),
      job.jobId,
    );
    if (result === 0) throw new GroupMessageRetryError();
    return result === 1;
  }

  async release(id: string, token: string): Promise<void> {
    await this.redis.eval(
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

  private remainingJobTtl(
    job: GroupMessageJob,
    retentionSeconds: number,
  ): number {
    const expiresAt = Date.parse(job.createdAt) + retentionSeconds * 1000;
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  }
}
