import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { LocalInfra } from './local-infra';
import { GroupMessageRuntime } from './group-runtime';

interface TargetResponse {
  targetId: string;
  ledgerKey?: string;
  applicationId?: string;
  participantId?: number;
}

interface PreviewResponse {
  previewId: string;
  items: TargetResponse[];
}

interface JobResponse {
  jobId: string;
}

interface StatusResponse {
  status: string;
  counts: {
    total: number;
    delivered: number;
    failed: number;
    unknown: number;
  };
  items: TargetResponse[];
}

interface HistoryResponse {
  items: Array<{
    type: string;
    targetScope: {
      kind: string;
      source?: string;
      applicationCount: number | null;
      programTypes: string[];
    };
  }>;
}

interface ConfigResponse {
  targetContracts: string[];
}

function responseBody<T>(response: { body: unknown }): T {
  return response.body as T;
}

function target(
  expoId: string,
  source: 'APPLICATION' | 'RESERVATION',
  suffix: string,
  content = '사전등록 안내',
) {
  const ledgerKey = `${source}:${expoId}:${suffix}`;
  return {
    targetId: ledgerKey,
    ledgerKey,
    ...(source === 'APPLICATION' ? { participantId: 42 } : {}),
    recipientPhone: '01012345678',
    content,
  };
}

describe('preregistration group-message HTTP/Redis contract', () => {
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

  function previewBody(
    expoId: string,
    targets: ReadonlyArray<Record<string, unknown>>,
    targetFingerprint = 'a'.repeat(64),
  ) {
    return {
      requesterUserId: 17,
      expoId,
      requestId: randomUUID(),
      applicationCount: targets.length,
      targetFingerprint,
      channel: 'SMS',
      targets,
    };
  }

  function authorization(body: {
    requesterUserId: number;
    expoId: string;
    targetFingerprint: string;
  }) {
    return {
      requesterUserId: body.requesterUserId,
      expoId: body.expoId,
      targetFingerprint: body.targetFingerprint,
      idempotencyKey: randomUUID(),
    };
  }

  it('declares the capability and preserves APPLICATION and RESERVATION identities through preview, job, status, and history', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const expoId = randomUUID();
    const application = target(expoId, 'APPLICATION', '1');
    const reservation = target(expoId, 'RESERVATION', 'r'.repeat(111));
    const body = previewBody(expoId, [application, reservation]);
    runtime.sender.sendResult = {
      kind: 'accepted',
      groupId: 'synthetic-group',
      messageId: 'm'.repeat(100),
    };

    const config = await request(server)
      .get('/internal/admin-group-messages/config')
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<ConfigResponse>(config).targetContracts).toContain(
      'PREREGISTRATION_GROUP_MESSAGE_V1',
    );

    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(previewBody(expoId, [target(randomUUID(), 'APPLICATION', '1')]))
      .expect(400);
    await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(
        previewBody(expoId, [
          application,
          {
            targetId: 'legacy-program',
            applicationId: randomUUID(),
            programType: 'STANDARD',
            recipientPhone: '01012345678',
            content: '기존 프로그램 안내',
          },
        ]),
      )
      .expect(400);

    const preview = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(body)
      .expect(201);
    const previewResponse = responseBody<PreviewResponse>(preview);
    const applicationPreview = previewResponse.items.find(
      (item) => item.ledgerKey === application.ledgerKey,
    );
    const reservationPreview = previewResponse.items.find(
      (item) => item.ledgerKey === reservation.ledgerKey,
    );
    expect(applicationPreview).toEqual(
      expect.objectContaining({
        targetId: application.ledgerKey,
        ledgerKey: application.ledgerKey,
        participantId: 42,
      }),
    );
    expect(applicationPreview).not.toHaveProperty('applicationId');
    expect(reservationPreview).toEqual(
      expect.objectContaining({
        targetId: reservation.ledgerKey,
        ledgerKey: reservation.ledgerKey,
      }),
    );
    expect(reservationPreview).not.toHaveProperty('applicationId');
    expect(reservationPreview).not.toHaveProperty('participantId');

    const job = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send(authorization(body))
      .expect(202);
    const jobResponse = responseBody<JobResponse>(job);
    await runtime.dispatch();
    await runtime.dispatch(jobResponse.jobId);
    const status = await request(server)
      .get(`/internal/admin-group-messages/jobs/${jobResponse.jobId}`)
      .query({ requesterUserId: body.requesterUserId, expoId })
      .set('X-Internal-Token', token)
      .expect(200);
    const statusResponse = responseBody<StatusResponse>(status);
    expect(statusResponse).toMatchObject({
      status: 'COMPLETED',
      counts: { total: 2, delivered: 2, failed: 0, unknown: 0 },
    });
    const reservationStatus = statusResponse.items.find(
      (item) => item.ledgerKey === reservation.ledgerKey,
    );
    expect(reservationStatus).not.toHaveProperty('applicationId');
    expect(reservationStatus).not.toHaveProperty('participantId');

    const history = await request(server)
      .get(`/internal/admin-group-messages/expos/${expoId}/history`)
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<HistoryResponse>(history).items).toContainEqual(
      expect.objectContaining({
        type: 'REQUESTED',
        targetScope: {
          kind: 'EXPLICIT_TARGETS',
          source: 'PREREGISTRATION',
          applicationCount: 2,
          programTypes: [],
        },
      }),
    );
  });

  it('retries confirmed preregistration failure once and never resends unknown acceptance', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const expoId = randomUUID();
    const body = previewBody(
      expoId,
      [
        target(expoId, 'APPLICATION', '2'),
        target(
          expoId,
          'RESERVATION',
          'request-without-user',
          '__FAKE_UNKNOWN__',
        ),
      ],
      'b'.repeat(64),
    );
    const preview = await request(server)
      .post('/internal/admin-group-messages/previews')
      .set('X-Internal-Token', token)
      .send(body)
      .expect(201);
    const previewResponse = responseBody<PreviewResponse>(preview);
    const job = await request(server)
      .post(
        `/internal/admin-group-messages/previews/${previewResponse.previewId}/jobs`,
      )
      .set('X-Internal-Token', token)
      .send(authorization(body))
      .expect(202);
    const jobResponse = responseBody<JobResponse>(job);
    runtime.sender.sendResult = { kind: 'rejected', code: '3001' };
    await runtime.dispatch();
    expect(runtime.sender.sends).toHaveLength(2);

    const firstStatus = await request(server)
      .get(`/internal/admin-group-messages/jobs/${jobResponse.jobId}`)
      .query({ requesterUserId: body.requesterUserId, expoId })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<StatusResponse>(firstStatus)).toMatchObject({
      status: 'ATTENTION',
      counts: { failed: 1, unknown: 1 },
    });

    const retry = authorization(body);
    const retryResponse = await request(server)
      .post(`/internal/admin-group-messages/jobs/${jobResponse.jobId}/retries`)
      .set('X-Internal-Token', token)
      .send(retry)
      .expect(202);
    const retried = responseBody<StatusResponse>(retryResponse);
    const retriedApplication = retried.items.find(
      (item) => item.ledgerKey === `APPLICATION:${expoId}:2`,
    );
    const retriedReservation = retried.items.find(
      (item) => item.ledgerKey === `RESERVATION:${expoId}:request-without-user`,
    );
    expect(retriedApplication).toMatchObject({
      ledgerKey: `APPLICATION:${expoId}:2`,
      participantId: 42,
    });
    expect(retriedApplication).not.toHaveProperty('applicationId');
    expect(retriedReservation).not.toHaveProperty('applicationId');
    expect(retriedReservation).not.toHaveProperty('participantId');
    runtime.sender.sendResult = {
      kind: 'accepted',
      groupId: 'synthetic-group',
      messageId: 'synthetic-message',
    };
    await runtime.dispatch();
    await runtime.dispatch(jobResponse.jobId);
    expect(runtime.sender.sends).toHaveLength(3);
    await request(server)
      .post(`/internal/admin-group-messages/jobs/${jobResponse.jobId}/retries`)
      .set('X-Internal-Token', token)
      .send(retry)
      .expect(202);
    await runtime.dispatch();
    expect(runtime.sender.sends).toHaveLength(3);
    const status = await request(server)
      .get(`/internal/admin-group-messages/jobs/${jobResponse.jobId}`)
      .query({ requesterUserId: body.requesterUserId, expoId })
      .set('X-Internal-Token', token)
      .expect(200);
    expect(responseBody<StatusResponse>(status)).toMatchObject({
      counts: { delivered: 1, failed: 0, unknown: 1 },
    });
  });

  it('reads an old Redis program job without preregistration fields', async () => {
    if (!runtime.app) throw new Error('runtime not started');
    const server = runtime.app.getHttpServer();
    const expoId = randomUUID();
    const jobId = 'f'.repeat(64);
    await runtime.redis.set(
      `admin-group-message:{jobs}:job:${jobId}`,
      JSON.stringify({
        jobId,
        previewId: randomUUID(),
        requesterUserId: 17,
        expoId,
        targetFingerprint: 'c'.repeat(64),
        channel: 'SMS',
        status: 'COMPLETED',
        createdAt: new Date().toISOString(),
        authorizedUntil: new Date().toISOString(),
        targets: [
          {
            targetId: 'legacy-program-target',
            applicationId: randomUUID(),
            participantId: 1,
            programType: 'STANDARD',
            recipientPhone: '01012345678',
            content: '기존 프로그램 안내',
            status: 'DELIVERED',
          },
        ],
      }),
    );

    const status = await request(server)
      .get(`/internal/admin-group-messages/jobs/${jobId}`)
      .query({ requesterUserId: 17, expoId })
      .set('X-Internal-Token', token)
      .expect(200);
    const response = responseBody<StatusResponse>(status);
    expect(response).toMatchObject({
      status: 'COMPLETED',
      counts: { total: 1, delivered: 1 },
    });
    expect(response.items[0]).toMatchObject({
      targetId: 'legacy-program-target',
      participantId: 1,
    });
    expect(response.items[0]).not.toHaveProperty('ledgerKey');
  });
});
