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
// 처리 중 대상별 진행 상태(targetId -> 대상 JSON). 본문 job 키에 합치기 전의 증분이다.
export const groupMessageDeltaKey = (id: string) =>
  `admin-group-message:{jobs}:delta:${id}`;
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

// 본문과 증분을 한 번에 읽는다. 둘 사이에 save가 끼어 낡은 본문에 증분이 빠지는 일이 없도록 한 스크립트로 읽는다.
export const readGroupMessageJobLua = `
return { redis.call('GET', KEYS[1]), redis.call('HGETALL', KEYS[2]) }`;

// 대상 1명분 상태만 쓴다(O(1)). 락 소유자만 쓸 수 있고, 락 TTL도 늘려 긴 묶음 처리 중 락이 풀리지 않게 한다.
export const saveGroupMessageTargetLua = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return 0 end
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[3], ttl)
redis.call('EXPIRE', KEYS[2], 30)
return 1`;

export const saveGroupMessageJobLua = `
${validateHistoryKeysLua}
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('DEL', KEYS[7])
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
redis.call('DEL', KEYS[8])
redis.call('SET', KEYS[7], '1', 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
${appendHistoryLua}
return 1`;
