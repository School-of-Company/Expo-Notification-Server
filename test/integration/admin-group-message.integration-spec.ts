import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { LocalInfra } from './local-infra';
import { GroupMessageRuntime } from './group-runtime';

function responseBody<T>(response: { body: unknown }): T {
  return response.body as T;
}

interface ConfigResponse {
  channels: { KAKAO: { enabled: boolean; templates: unknown[] } };
  smsFallbackDefault: boolean;
}

interface PreviewResponse {
  previewId: string;
}

interface JobResponse {
  jobId: string;
}

interface HistoryResponse {
  items: Array<{
    eventId: string;
    type: 'REQUESTED' | 'SENT' | 'FAILED' | 'RETRIED';
    occurredAt: string;
    jobId: string;
    adminId: number;
    targetScope: {
      kind: 'EXPLICIT_TARGETS';
      applicationCount: number | null;
      programTypes: Array<'STANDARD' | 'TRAINING'>;
    };
  }>;
  nextCursor?: string;
}

function historyMember(
  event: HistoryResponse['items'][number] & object,
): string {
  return `${String(Date.parse(event.occurredAt)).padStart(13, '0')}:${event.eventId}|${Buffer.from(JSON.stringify(event)).toString('base64url')}`;
}

describe('admin group message HTTP/Redis contracts with fake provider', () => {
  const infra = new LocalInfra();
  const token = 'g'.repeat(32);
  let runtime: GroupMessageRuntime;

  beforeAll(() => infra.start());
  beforeEach(async () => {
    runtime = new GroupMessageRuntime(infra);
    await runtime.start();
  });
  afterEach(() => runtime.close());
  afterAll(() => infra.stop());

  function previewBody() {
    return {
      requesterUserId: 17,
      expoId: randomUUID(),
      requestId: randomUUID(),
      applicationCount: 3,
      targetFingerprint: 'a'.repeat(64),
      channel: 'SMS',
      fallbackToSms: false,
      targets: [
        {
          targetId: 'participant-1',
          applicationId: randomUUID(),
          participantId: 1,
          programType: 'STANDARD',
          recipientPhone: '01012345678',
          content: '김학생님의 개별 안내',
        },
        {
          targetId: 'participant-2',
          applicationId: randomUUID(),
          participantId: 2,
          programType: 'TRAINING',
          missingReason: 'MISSING_REPRESENTATIVE_PHONE',
        },
      ],
    } as const;
  }

  it('protects routes, preserves personal preview, and never duplicates a preview job', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const body = previewBody();
    await request(server)
      .get('/internal/admin-group-messages/config')
      .expect(403);
    const configResult = await request(server)
      .get('/internal/admin-group-messages/config')
      .set('X-Internal-Token', token)
      .expect(200);
    const config = responseBody<ConfigResponse>(configResult);
    expect(config.channels.KAKAO).toEqual({
      enabled: false,
      templates: [],
    });
    expect(config.smsFallbackDefault).toBe(false);
    const preview = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(body)
      .expect(201);
    expect(responseBody<unknown>(preview)).toMatchObject({
      targetCount: 2,
      applicationCount: 3,
      recipientCount: 1,
      messageCount: 1,
      sendableCount: 1,
      missingCount: 1,
      items: [
        {
          targetId: 'participant-1',
          recipientMasked: '010****5678',
          content: '김학생님의 개별 안내',
        },
        {
          targetId: 'participant-2',
          missingReason: 'MISSING_REPRESENTATIVE_PHONE',
        },
      ],
    });
    const replay = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(body)
      .expect(201);
    const previewResponse = responseBody<PreviewResponse>(preview);
    expect(responseBody<PreviewResponse>(replay).previewId).toBe(
      previewResponse.previewId,
    );
    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({ ...body, targetFingerprint: 'b'.repeat(64) })
      .expect(409);

    const authorize = {
      requesterUserId: body.requesterUserId,
      expoId: body.expoId,
      targetFingerprint: body.targetFingerprint,
      idempotencyKey: randomUUID(),
    };
    await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send({ ...authorize, targetFingerprint: 'c'.repeat(64) })
      .expect(409);
    const first = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send(authorize)
      .expect(202);
    const second = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send({ ...authorize, idempotencyKey: randomUUID() })
      .expect(202);
    const firstJob = responseBody<JobResponse>(first);
    expect(responseBody<JobResponse>(second).jobId).toBe(firstJob.jobId);
    await runtime.dispatch();
    await runtime.dispatch(firstJob.jobId);
    expect(runtime.sender.sends).toHaveLength(1);
    const status = await request(server)
      .get(`/internal/admin-group-messages/jobs/${firstJob.jobId}`)
      .query({ requesterUserId: body.requesterUserId, expoId: body.expoId })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<unknown>(status)).toMatchObject({
      status: 'COMPLETED',
      counts: { total: 2, delivered: 1, missing: 1, failed: 0, unknown: 0 },
    });
    await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .expect(401);
    await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .set('X-Internal-Token', 'x'.repeat(32))
      .expect(401);
    await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .query({ requesterUserId: 18 })
      .set('X-Internal-Token', token)
      .expect(400);
    const historyResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    const history = responseBody<HistoryResponse>(historyResult);
    expect(history.items.map((event) => event.type)).toEqual([
      'SENT',
      'REQUESTED',
    ]);
    const requested = history.items.find((event) => event.type === 'REQUESTED');
    expect(requested?.adminId).toBe(body.requesterUserId);
    expect(requested?.jobId).toBe(firstJob.jobId);
    expect(requested?.targetScope).toEqual({
      kind: 'EXPLICIT_TARGETS',
      applicationCount: body.applicationCount,
      programTypes: ['STANDARD', 'TRAINING'],
    });
    expect(JSON.stringify(history)).not.toContain('01012345678');
    expect(JSON.stringify(history)).not.toContain('개별 안내');
    expect(JSON.stringify(history)).not.toContain(body.targetFingerprint);
    expect(
      await runtime.redis.ttl(
        `admin-group-message:{jobs}:history:${body.expoId}:ALL`,
      ),
    ).toBeGreaterThan(0);
    const otherExpo = await request(server)
      .get(`/internal/admin-group-messages/expos/${randomUUID()}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(otherExpo).items).toEqual([]);
    await request(server)
      .get(`/internal/admin-group-messages/jobs/${firstJob.jobId}`)
      .query({ requesterUserId: 18, expoId: body.expoId })
      .set('X-Internal-Token', token)
      .expect(409);
  });

  it('does not retry unknown acceptance and retries confirmed failure once per operation key', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const body = previewBody();
    const preview = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({
        ...body,
        targets: [{ ...body.targets[0], content: '__FAKE_UNKNOWN__' }],
      })
      .expect(201);
    const previewResponse = responseBody<PreviewResponse>(preview);
    const authorization = {
      requesterUserId: body.requesterUserId,
      expoId: body.expoId,
      targetFingerprint: body.targetFingerprint,
      idempotencyKey: randomUUID(),
    };
    const job = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send(authorization)
      .expect(202);
    const jobResponse = responseBody<JobResponse>(job);
    await runtime.dispatch();
    await request(server)
      .post(`/internal/admin-group-messages/jobs/${jobResponse.jobId}/retries`)
      .set('X-Internal-Token', token)
      .send({ ...authorization, idempotencyKey: randomUUID() })
      .expect(202);
    await runtime.dispatch();
    expect(runtime.sender.sends).toHaveLength(1);

    const failureBody = { ...previewBody(), targetFingerprint: 'd'.repeat(64) };
    const failedPreview = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({
        ...failureBody,
        targets: [
          {
            ...failureBody.targets[0],
            content: '__FAKE_CONFIRMED_FAILURE__',
          },
        ],
      })
      .expect(201);
    const failedPreviewResponse = responseBody<PreviewResponse>(failedPreview);
    const failedAuthorization = {
      requesterUserId: failureBody.requesterUserId,
      expoId: failureBody.expoId,
      targetFingerprint: failureBody.targetFingerprint,
      idempotencyKey: randomUUID(),
    };
    const failedJob = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${failedPreviewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send(failedAuthorization)
      .expect(202);
    const failedJobResponse = responseBody<JobResponse>(failedJob);
    await runtime.dispatch();
    const retryKey = randomUUID();
    await request(server)
      .post(
        `/internal/admin-group-messages/jobs/${failedJobResponse.jobId}/retries`,
      )
      .set('X-Internal-Token', token)
      .send({ ...failedAuthorization, idempotencyKey: retryKey })
      .expect(202);
    await runtime.dispatch();
    expect(runtime.sender.sends).toHaveLength(3);
    await request(server)
      .post(
        `/internal/admin-group-messages/jobs/${failedJobResponse.jobId}/retries`,
      )
      .set('X-Internal-Token', token)
      .send({ ...failedAuthorization, idempotencyKey: retryKey })
      .expect(202);
    await runtime.dispatch();
    expect(runtime.sender.sends).toHaveLength(3);
    const retryHistory = await request(server)
      .get(`/internal/admin-group-messages/expos/${failureBody.expoId}/history`)
      .query({ type: 'RETRIED' })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(retryHistory).items).toHaveLength(1);
  });

  it('paginates equal timestamps stably and applies inclusive/exclusive period bounds', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const expoId = randomUUID();
    const jobId = 'e'.repeat(64);
    const occurredAt = new Date(Date.now() - 10_000).toISOString();
    const event = (eventId: string, at = occurredAt) => ({
      eventId,
      type: 'REQUESTED' as const,
      adminId: 17,
      occurredAt: at,
      targetScope: {
        kind: 'EXPLICIT_TARGETS' as const,
        applicationCount: 1,
        programTypes: ['STANDARD' as const],
      },
      counts: {
        total: 1,
        pending: 1,
        accepted: 0,
        delivered: 0,
        failed: 0,
        unknown: 0,
        missing: 0,
      },
      status: 'QUEUED' as const,
      jobId,
    });
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    const key = `admin-group-message:{jobs}:history:${expoId}:ALL`;
    await runtime.redis.zadd(
      key,
      0,
      historyMember(event(ids[0])),
      0,
      historyMember(event(ids[1])),
    );
    const firstResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ from: occurredAt, limit: 1 })
      .set('X-Internal-Token', token)
      .expect(200);
    const first = responseBody<HistoryResponse>(firstResult);
    expect(first.items.map((item) => item.eventId)).toEqual([ids[1]]);
    expect(first.nextCursor).toBeDefined();
    const secondResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ from: occurredAt, limit: 1, cursor: first.nextCursor })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(
      responseBody<HistoryResponse>(secondResult).items.map(
        (item) => item.eventId,
      ),
    ).toEqual([ids[0]]);
    const narrowedCursorResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ to: occurredAt, cursor: first.nextCursor })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(narrowedCursorResult).items).toEqual(
      [],
    );
    const exclusiveResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ from: occurredAt, to: occurredAt })
      .set('X-Internal-Token', token)
      .expect(400);
    expect(exclusiveResult.body).toBeDefined();

    const nextMillisecond = new Date(Date.parse(occurredAt) + 1).toISOString();
    const boundedResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ from: occurredAt, to: nextMillisecond })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(boundedResult).items).toHaveLength(2);
    const toExclusiveResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .query({ to: occurredAt })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(toExclusiveResult).items).toEqual([]);

    const expired = event(
      '00000000-0000-4000-8000-000000000003',
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const expiredMember = historyMember(expired);
    await runtime.redis.zadd(key, 0, expiredMember);
    await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    expect(await runtime.redis.zscore(key, expiredMember)).toBeNull();
  });

  it('records a failed aggregate only after every target is settled', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const body = previewBody();
    const previewResult = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({
        ...body,
        targets: [
          { ...body.targets[0], content: '__FAKE_UNKNOWN__' },
          {
            ...body.targets[0],
            targetId: 'participant-2',
            applicationId: randomUUID(),
            participantId: 2,
            content: '정상 안내',
          },
        ],
      })
      .expect(201);
    const preview = responseBody<PreviewResponse>(previewResult);
    const jobResult = await request(server)
      .post(`/internal/admin-group-messages/previews/${preview.previewId}/jobs`)
      .set('X-Internal-Token', token)
      .send({
        requesterUserId: body.requesterUserId,
        expoId: body.expoId,
        targetFingerprint: body.targetFingerprint,
        idempotencyKey: randomUUID(),
      })
      .expect(202);
    const job = responseBody<JobResponse>(jobResult);
    await runtime.dispatch();
    const intermediateResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    expect(
      responseBody<HistoryResponse>(intermediateResult).items.map(
        (item) => item.type,
      ),
    ).toEqual(['REQUESTED']);

    await runtime.dispatch(job.jobId);
    const finalResult = await request(server)
      .get(`/internal/admin-group-messages/expos/${body.expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    expect(
      responseBody<HistoryResponse>(finalResult).items.map((item) => item.type),
    ).toEqual(['FAILED', 'REQUESTED']);
  });

  it('rejects duplicate targets, oversized UTF-8 SMS, and unconfigured Kakao', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const body = previewBody();
    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({ ...body, targets: [body.targets[0], body.targets[0]] })
      .expect(400);
    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({
        ...body,
        requestId: randomUUID(),
        targets: [{ ...body.targets[0], content: '가'.repeat(667) }],
      })
      .expect(422);
    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send({
        ...body,
        requestId: randomUUID(),
        channel: 'KAKAO',
        templateId: 'not-configured',
      })
      .expect(422);
  });

  it('removes expired job IDs from the durable due queue', async () => {
    const staleJobId = 'f'.repeat(64);
    await runtime.redis.zadd(
      'admin-group-message:{jobs}:due',
      Date.now() - 1,
      staleJobId,
    );
    await runtime.dispatch();
    expect(
      await runtime.redis.zscore('admin-group-message:{jobs}:due', staleJobId),
    ).toBeNull();
  });

  it('returns a generic 503 when the history index is unavailable', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const expoId = randomUUID();
    await runtime.redis.set(
      `admin-group-message:{jobs}:history:${expoId}:ALL`,
      'corrupt',
    );
    const response = await request(runtime.app.getHttpServer())
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(503);
    expect(response.body).toMatchObject({
      statusCode: 503,
      message: 'group message history unavailable',
    });
    expect(JSON.stringify(response.body)).not.toContain('WRONGTYPE');
  });

  it('does not create a job when its history index has an invalid Redis type', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const body = previewBody();
    const previewResult = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(body)
      .expect(201);
    const preview = responseBody<PreviewResponse>(previewResult);
    await runtime.redis.set(
      `admin-group-message:{jobs}:history:${body.expoId}:ALL`,
      'corrupt',
    );
    const errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await request(server)
        .post(
          `/internal/admin-group-messages/previews/${preview.previewId}/jobs`,
        )
        .set('X-Internal-Token', token)
        .send({
          requesterUserId: body.requesterUserId,
          expoId: body.expoId,
          targetFingerprint: body.targetFingerprint,
          idempotencyKey: randomUUID(),
        })
        .expect(500);
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).not.toContain(body.targets[0].recipientPhone);
      expect(logged).not.toContain(body.targets[0].content);
      expect(logged).not.toContain(body.targetFingerprint);
    } finally {
      errors.mockRestore();
    }
    await expect(
      runtime.store.getJobForPreview(preview.previewId),
    ).resolves.toBeNull();
  });

  it('expires the Redis history index at the event retention deadline', async () => {
    await runtime.close();
    runtime = new GroupMessageRuntime(infra, 1, false);
    await runtime.start();
    const expoId = randomUUID();
    await runtime.store.createJob({
      previewId: randomUUID(),
      requesterUserId: 17,
      expoId,
      requestId: randomUUID(),
      applicationCount: 1,
      targetFingerprint: 'a'.repeat(64),
      channel: 'SMS',
      fallbackToSms: false,
      targets: [
        {
          targetId: 'participant-1',
          applicationId: randomUUID(),
          participantId: 1,
          programType: 'STANDARD',
          recipientPhone: '01012345678',
          content: '안내',
        },
      ],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const key = `admin-group-message:{jobs}:history:${expoId}:ALL`;
    expect(await runtime.redis.ttl(key)).toBeGreaterThan(0);
    expect(await runtime.redis.ttl(key)).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(await runtime.redis.exists(key)).toBe(0);
  });
});
