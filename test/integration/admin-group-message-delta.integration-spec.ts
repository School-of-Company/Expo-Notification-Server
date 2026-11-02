import { randomUUID } from 'node:crypto';
import { GroupMessageRetryError } from '../../src/admin-group-message/admin-group-message.schema';
import type { GroupMessageJob } from '../../src/admin-group-message/admin-group-message.schema';
import {
  groupMessageDeltaKey,
  groupMessageJobKey,
  groupMessageLockKey,
} from '../../src/admin-group-message/admin-group-message-job.scripts';
import { LocalInfra } from './local-infra';
import { GroupMessageRuntime } from './group-runtime';

// 대상별 증분 저장(#126)의 Lua 불변식을 실제 Redis로 확인한다.
// saveTarget은 락 소유자만 쓰고, save/saveRetry는 본문을 쓰면서 증분을 지우며, getJob은 본문과 증분을 합쳐 읽는다.
describe('admin group message target delta (real Redis)', () => {
  const infra = new LocalInfra();
  let runtime: GroupMessageRuntime;

  const target = (n: number): GroupMessageJob['targets'][number] => ({
    targetId: `target-${n}`,
    applicationId: randomUUID(),
    participantId: n,
    programType: 'STANDARD',
    recipientPhone: '01012345678',
    content: '개별 안내',
    status: 'PENDING',
  });
  const job = (): GroupMessageJob => ({
    jobId: 'c'.repeat(64),
    previewId: randomUUID(),
    requesterUserId: 1,
    expoId: randomUUID(),
    targetFingerprint: 'b'.repeat(64),
    channel: 'SMS',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    authorizedUntil: new Date(Date.now() + 60_000).toISOString(),
    targets: [target(1), target(2)],
  });
  const sending = (
    record: GroupMessageJob,
    index: number,
  ): GroupMessageJob['targets'][number] => ({
    ...record.targets[index],
    status: 'SENDING',
    attemptId: randomUUID(),
    attemptedAt: new Date().toISOString(),
  });
  const seed = async (record: GroupMessageJob, ttlSeconds = 600) => {
    await runtime.redis.set(
      groupMessageJobKey(record.jobId),
      JSON.stringify(record),
      'EX',
      ttlSeconds,
    );
  };
  const deltaExists = async (jobId: string) =>
    (await runtime.redis.exists(groupMessageDeltaKey(jobId))) === 1;

  beforeAll(() => infra.start());
  beforeEach(async () => {
    runtime = new GroupMessageRuntime(infra);
    await runtime.start();
  });
  afterEach(() => runtime.close());
  afterAll(() => infra.stop());

  it('saveTarget은 대상 1건만 증분에 쓰고 getJob은 본문 순서대로 합쳐 읽는다', async () => {
    const record = job();
    await seed(record);
    const token = (await runtime.store.claim(record.jobId))!;

    await runtime.store.saveTarget(record.jobId, token, sending(record, 1));

    const raw = await runtime.redis.get(groupMessageJobKey(record.jobId));
    expect((JSON.parse(raw!) as GroupMessageJob).targets[1].status).toBe(
      'PENDING',
    );
    const merged = await runtime.store.getJob(record.jobId);
    expect(merged?.targets.map((t) => [t.targetId, t.status])).toEqual([
      ['target-1', 'PENDING'],
      ['target-2', 'SENDING'],
    ]);
    // 증분은 job과 같이 만료된다
    const deltaTtl = await runtime.redis.pttl(
      groupMessageDeltaKey(record.jobId),
    );
    expect(deltaTtl).toBeGreaterThan(590_000);
    expect(deltaTtl).toBeLessThanOrEqual(600_000);
  });

  it('saveTarget은 락을 30초로 다시 늘린다', async () => {
    const record = job();
    await seed(record);
    const token = (await runtime.store.claim(record.jobId))!;
    await runtime.redis.expire(groupMessageLockKey(record.jobId), 5);

    await runtime.store.saveTarget(record.jobId, token, sending(record, 0));

    expect(
      await runtime.redis.ttl(groupMessageLockKey(record.jobId)),
    ).toBeGreaterThan(25);
  });

  it('락을 잃었거나 job에 TTL이 없으면 쓰지 않고 실패한다', async () => {
    const record = job();
    await seed(record);
    await runtime.store.claim(record.jobId);

    await expect(
      runtime.store.saveTarget(record.jobId, 'other', sending(record, 0)),
    ).rejects.toBeInstanceOf(GroupMessageRetryError);
    expect(await deltaExists(record.jobId)).toBe(false);

    const persistent = { ...job(), jobId: 'd'.repeat(64) };
    await runtime.redis.set(
      groupMessageJobKey(persistent.jobId),
      JSON.stringify(persistent),
    );
    const token = (await runtime.store.claim(persistent.jobId))!;
    await expect(
      runtime.store.saveTarget(persistent.jobId, token, sending(persistent, 0)),
    ).rejects.toBeInstanceOf(GroupMessageRetryError);
    expect(await deltaExists(persistent.jobId)).toBe(false);
  });

  it('save는 본문을 쓰면서 증분을 지운다', async () => {
    const record = job();
    await seed(record);
    const token = (await runtime.store.claim(record.jobId))!;
    await runtime.store.saveTarget(record.jobId, token, sending(record, 0));

    const merged = (await runtime.store.getJob(record.jobId))!;
    merged.targets[0] = {
      ...merged.targets[0],
      status: 'ACCEPTED',
      groupId: 'group',
      messageId: 'message',
    };
    await runtime.store.save(merged, token);

    expect(await deltaExists(record.jobId)).toBe(false);
    const saved = await runtime.store.getJob(record.jobId);
    expect(saved?.targets[0].status).toBe('ACCEPTED');
  });

  it('saveRetry도 증분을 지워, 재시도한 job에 낡은 SENDING이 덮이지 않는다', async () => {
    const record = job();
    await seed(record);
    const token = (await runtime.store.claim(record.jobId))!;
    await runtime.store.saveTarget(record.jobId, token, sending(record, 0));

    const retried = job();
    retried.targets = record.targets.map((t) => ({ ...t, status: 'PENDING' }));
    await expect(
      runtime.store.saveRetry(retried, token, randomUUID()),
    ).resolves.toBe(true);

    expect(await deltaExists(record.jobId)).toBe(false);
    const saved = await runtime.store.getJob(record.jobId);
    expect(saved?.targets.map((t) => t.status)).toEqual(['PENDING', 'PENDING']);
  });
});
