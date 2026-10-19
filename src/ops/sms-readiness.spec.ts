import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import {
  collectReadiness,
  evaluateReadiness,
  parseRedisInfo,
  readReleaseManifest,
  ReadinessKafkaAdmin,
  ReadinessRedis,
  ReadinessReport,
} from './sms-readiness';

const SHA = 'a'.repeat(40);
const config = createAppConfig();

function fakeAdmin(
  overrides: Partial<Record<keyof ReadinessKafkaAdmin, jest.Mock>> = {},
): Record<keyof ReadinessKafkaAdmin, jest.Mock> {
  return {
    listTopics: jest
      .fn()
      .mockResolvedValue([
        'notification.sms.requested',
        'notification.sms.requested.dlq',
        'notification.qr-sms.sent',
        'other',
      ]),
    fetchTopicMetadata: jest
      .fn()
      .mockImplementation(({ topics }: { topics: string[] }) =>
        Promise.resolve({
          topics: topics.map((name) => ({ name, partitions: [{}, {}] })),
        }),
      ),
    describeGroups: jest.fn().mockResolvedValue({
      groups: [{ state: 'Stable', members: [{ clientHost: '/10.0.0.1' }] }],
    }),
    fetchOffsets: jest.fn().mockResolvedValue([
      {
        topic: 'notification.sms.requested',
        partitions: [
          { partition: 0, offset: '10' },
          { partition: 1, offset: '7' },
        ],
      },
    ]),
    fetchTopicOffsets: jest.fn().mockResolvedValue([
      { partition: 1, high: '7' },
      { partition: 0, high: '12' },
    ]),
    ...overrides,
  };
}

const redisInfo: Record<string, string> = {
  replication: '# Replication\r\nrole:master\r\n',
  persistence:
    '# Persistence\r\naof_enabled:1\r\naof_last_write_status:ok\r\nrdb_last_bgsave_status:ok\r\nrdb_last_save_time:1760000000\r\n',
  memory: '# Memory\r\nmaxmemory_policy:noeviction\r\n',
};

function fakeRedis(info = redisInfo): ReadinessRedis & { info: jest.Mock } {
  return {
    info: jest.fn((section: string) => Promise.resolve(info[section] ?? '')),
  };
}

async function report(
  admin = fakeAdmin(),
  redis: ReadinessRedis = fakeRedis(),
  release: { sha: string } | null = { sha: SHA },
): Promise<ReadinessReport> {
  return evaluateReadiness(
    await collectReadiness(config, {
      admin,
      redis,
      release,
      now: () => new Date('2026-10-19T00:00:00Z'),
    }),
  );
}

const status = (result: ReadinessReport, name: string) =>
  result.checks.find((check) => check.name === name)?.status;

describe('sms readiness', () => {
  it('모든 자동 점검이 통과하면 ready이고 사람이 볼 항목은 manual로 남긴다', async () => {
    const result = await report();

    expect(result.ready).toBe(true);
    expect(result.sms).toEqual({
      doneMarker: 'done-v2',
      doneTtlSeconds: 604800,
      eventMaxAttempts: 5,
      traineeSenderConfigured: true,
      apiBaseUrlHost: null,
    });
    expect(result.kafka.requestedOffsets).toEqual([
      { partition: 0, committed: '10', logEnd: '12', lag: '2' },
      { partition: 1, committed: '7', logEnd: '7', lag: '0' },
    ]);
    expect(result.kafka.group).toEqual({ state: 'Stable', members: 1 });
    expect(result.redis).toMatchObject({
      role: 'master',
      aofEnabled: true,
      maxmemoryPolicy: 'noeviction',
      rdbLastSaveTime: '2025-10-09T08:53:20.000Z',
    });
    expect(
      result.checks
        .filter((check) => check.status === 'manual')
        .map((check) => check.name),
    ).toEqual(['sms.traineeSender', 'redis.persistence', 'kafka.acl']);
  });

  it('비밀값과 member 접속 정보를 출력하지 않는다', async () => {
    const text = JSON.stringify(await report());

    for (const secret of [
      config.sms.fromTraineeNumber,
      config.sms.apiSecret,
      config.sms.apiKey,
      '10.0.0.1',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('SMS_API_BASE_URL이 없으면 sms.apiBaseUrl은 ok다', async () => {
    const result = await report();

    expect(status(result, 'sms.apiBaseUrl')).toBe('ok');
    expect(result.sms.apiBaseUrlHost).toBeNull();
  });

  it('SMS_API_BASE_URL이 있으면 실패로 보고 ready를 막되 호스트만 출력한다', async () => {
    const withUrl = createAppConfig({
      sms: {
        ...config.sms,
        apiBaseUrl: 'http://user:pw@x.test:8080/secret/path?token=abc',
      },
    });

    const result = evaluateReadiness(
      await collectReadiness(withUrl, {
        admin: fakeAdmin(),
        redis: fakeRedis(),
        release: { sha: SHA },
      }),
    );

    expect(status(result, 'sms.apiBaseUrl')).toBe('fail');
    expect(result.ready).toBe(false);
    expect(result.sms.apiBaseUrlHost).toBe('x.test:8080');
    const text = JSON.stringify(result);
    expect(text).toContain('x.test');
    for (const leaked of ['user', 'pw@', '/secret/path', 'token=abc']) {
      expect(text).not.toContain(leaked);
    }
    expect(
      result.checks
        .filter((check) => check.status === 'fail')
        .map((c) => c.name),
    ).toEqual(['sms.apiBaseUrl']);
  });

  it('없는 토픽은 메타데이터를 요청하지 않는다(자동 생성 방지)', async () => {
    const admin = fakeAdmin({
      listTopics: jest.fn().mockResolvedValue(['notification.sms.requested']),
    });

    const result = await report(admin);

    expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({
      topics: ['notification.sms.requested'],
    });
    expect(status(result, 'kafka.topic.smsDeadLetter')).toBe('fail');
    expect(status(result, 'kafka.topic.qrSmsSent')).toBe('fail');
    expect(result.ready).toBe(false);
  });

  it('요청 토픽이 없으면 offset을 조회하지 않고 실패로 본다', async () => {
    const admin = fakeAdmin({ listTopics: jest.fn().mockResolvedValue([]) });

    const result = await report(admin);

    expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
    expect(admin.fetchOffsets).not.toHaveBeenCalled();
    expect(status(result, 'kafka.committedOffsets')).toBe('fail');
  });

  it('committed offset이 없는 partition이 있으면 준비되지 않은 것으로 본다', async () => {
    const admin = fakeAdmin({
      fetchOffsets: jest.fn().mockResolvedValue([
        {
          topic: 'notification.sms.requested',
          partitions: [
            { partition: 0, offset: '10' },
            { partition: 1, offset: '-1' },
          ],
        },
      ]),
    });

    const result = await report(admin);

    expect(result.kafka.requestedOffsets?.[1]).toEqual({
      partition: 1,
      committed: null,
      logEnd: '7',
      lag: null,
    });
    expect(status(result, 'kafka.committedOffsets')).toBe('fail');
    expect(result.ready).toBe(false);
  });

  it('consumer가 group에 없으면 실패로 본다', async () => {
    const admin = fakeAdmin({
      describeGroups: jest
        .fn()
        .mockResolvedValue({ groups: [{ state: 'Empty', members: [] }] }),
    });

    expect(status(await report(admin), 'kafka.group')).toBe('fail');
  });

  it('Kafka 조회 실패를 토픽 실패로 기록한다', async () => {
    const admin = fakeAdmin({
      listTopics: jest.fn().mockRejectedValue(new Error('broker down')),
    });

    const result = await report(admin);

    expect(result.kafka.error).toBe('broker down');
    expect(status(result, 'kafka.topic.smsRequested')).toBe('fail');
    expect(result.ready).toBe(false);
  });

  it('eviction 정책이면 완료 마커 유실 위험으로 실패 처리한다', async () => {
    const redis = fakeRedis({
      ...redisInfo,
      memory: 'maxmemory_policy:volatile-lru\r\n',
    });

    expect(
      status(await report(fakeAdmin(), redis), 'redis.maxmemoryPolicy'),
    ).toBe('fail');
  });

  it('Redis INFO 실패를 실패로 기록한다', async () => {
    const redis = { info: jest.fn().mockRejectedValue(new Error('NOPERM')) };

    const result = await report(fakeAdmin(), redis);

    expect(result.redis).toEqual({ error: 'NOPERM' });
    expect(status(result, 'redis.info')).toBe('fail');
  });

  it('release.json이 없으면 SHA는 수동 확인으로 남긴다', async () => {
    expect(
      status(await report(fakeAdmin(), fakeRedis(), null), 'release.sha'),
    ).toBe('manual');
  });
});

describe('readReleaseManifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));

  it('전체 SHA와 run 정보를 읽는다', () => {
    const path = join(dir, 'ok.json');
    writeFileSync(
      path,
      JSON.stringify({
        sha: SHA,
        release: 'aaaaaaaaaaaa-1',
        runId: '9',
        extra: 1,
      }),
    );

    expect(readReleaseManifest(path)).toEqual({
      sha: SHA,
      release: 'aaaaaaaaaaaa-1',
      runId: '9',
      runAttempt: undefined,
      runUrl: undefined,
      builtAt: undefined,
    });
  });

  it('파일이 없거나 SHA가 전체 40자리가 아니면 null', () => {
    const path = join(dir, 'short.json');
    writeFileSync(path, JSON.stringify({ sha: 'abc123' }));

    expect(readReleaseManifest(path)).toBeNull();
    expect(readReleaseManifest(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('parseRedisInfo', () => {
  it('주석과 빈 줄을 건너뛰고 key:value를 읽는다', () => {
    expect(parseRedisInfo('# Memory\r\n\r\nused_memory:1\r\na:b:c\n')).toEqual({
      used_memory: '1',
      a: 'b:c',
    });
  });
});
