import { randomUUID } from 'node:crypto';
import { mergeTargetDelta } from './admin-group-message-delta';
import {
  GroupMessageRetryError,
  parseGroupMessageJob,
} from './admin-group-message.schema';

describe('mergeTargetDelta', () => {
  const target = (targetId: string) => ({
    targetId,
    applicationId: randomUUID(),
    programType: 'STANDARD',
    recipientPhone: '01012345678',
    content: '안내',
    status: 'PENDING',
  });
  const raw = JSON.stringify({
    jobId: 'a'.repeat(64),
    previewId: randomUUID(),
    requesterUserId: 1,
    expoId: randomUUID(),
    targetFingerprint: 'b'.repeat(64),
    channel: 'SMS',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    authorizedUntil: new Date().toISOString(),
    targets: [target('t1'), target('t2')],
  });

  it('증분이 없으면 이전 레이아웃 job을 그대로 읽는다', () => {
    const job = parseGroupMessageJob(mergeTargetDelta(raw, []));
    expect(job.targets.map((item) => item.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
  });

  it('증분의 대상 상태가 본문보다 우선하고 순서는 유지된다', () => {
    const sending = {
      ...target('t1'),
      status: 'SENDING',
      attemptId: randomUUID(),
      attemptedAt: new Date().toISOString(),
    };
    const job = parseGroupMessageJob(
      mergeTargetDelta(raw, ['t1', JSON.stringify(sending)]),
    );
    expect(job.targets.map((item) => [item.targetId, item.status])).toEqual([
      ['t1', 'SENDING'],
      ['t2', 'PENDING'],
    ]);
  });

  it('증분 JSON이 깨졌으면 재시도 오류다', () => {
    expect(() => mergeTargetDelta(raw, ['t1', '{'])).toThrow(
      GroupMessageRetryError,
    );
  });
});
