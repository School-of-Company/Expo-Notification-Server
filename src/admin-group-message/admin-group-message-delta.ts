import { GroupMessageRetryError } from './admin-group-message.schema';

/**
 * job 본문 JSON에 대상별 진행 상태 증분(`delta:{jobId}` HASH)을 덮어쓴 JSON을 돌려준다(#126).
 * 증분은 `HGETALL` 결과 그대로 `[targetId, 대상 JSON, ...]`이고, 대상 순서는 본문을 따른다.
 * 증분이 없으면(이전 레이아웃 job 포함) 본문을 그대로 돌려준다.
 */
export function mergeTargetDelta(
  raw: string,
  delta: readonly string[],
): string {
  if (delta.length === 0) return raw;
  try {
    const latest = new Map<string, unknown>();
    for (let index = 0; index + 1 < delta.length; index += 2)
      latest.set(delta[index], JSON.parse(delta[index + 1]));
    const body = JSON.parse(raw) as { targets?: Array<{ targetId?: string }> };
    body.targets = body.targets?.map(
      (target) => latest.get(target.targetId ?? '') ?? target,
    );
    return JSON.stringify(body);
  } catch {
    throw new GroupMessageRetryError();
  }
}
