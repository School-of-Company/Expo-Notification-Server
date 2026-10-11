import { randomUUID } from 'node:crypto';
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
});
