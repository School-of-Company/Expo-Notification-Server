import {
  appendHistoryLua,
  validateHistoryKeysLua,
} from './admin-group-message-history.store';
import { createHash } from 'node:crypto';
import type { GroupMessageJob } from './admin-group-message.schema';

export const groupMessageQueueKey = 'admin-group-message:{jobs}:due';
export const groupMessageJobKey = (id: string) =>
  `admin-group-message:{jobs}:job:${id}`;
export const groupMessageLockKey = (id: string) =>
  `admin-group-message:{jobs}:lock:${id}`;
export const groupMessageRetryOperationKey = (
  id: string,
  operationId: string,
) => `admin-group-message:{jobs}:retry:${id}:${operationId}`;

export function groupMessageJobId(previewId: string): string {
  return createHash('sha256')
    .update(`admin-group-message:${previewId}`)
    .digest('hex');
}

export function remainingGroupMessageJobTtl(
  job: GroupMessageJob,
  retentionSeconds: number,
): number {
  const expiresAt = Date.parse(job.createdAt) + retentionSeconds * 1000;
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

export const createGroupMessageJobLua = `
${validateHistoryKeysLua}
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
  ${appendHistoryLua}
end
return 1`;

export const saveGroupMessageJobLua = `
${validateHistoryKeysLua}
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
if ARGV[4] == '0' then redis.call('ZREM', KEYS[3], ARGV[5])
else redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5]) end
if ARGV[9] ~= '' and redis.call('HGET', KEYS[6], 'lastType') ~= ARGV[9] then
  ${appendHistoryLua}
end
return 1`;

export const saveGroupMessageRetryLua = `
${validateHistoryKeysLua}
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[7]) == 1 then return 2 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[7], '1', 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
${appendHistoryLua}
return 1`;
