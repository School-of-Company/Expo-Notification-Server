import { randomUUID } from 'node:crypto';
import {
  groupMessageHistoryMutation,
  type GroupMessageHistoryMutation,
} from './admin-group-message-history.store';
import {
  createGroupMessagePreviewSchema,
  parseGroupMessageJob,
  type GroupMessageJob,
} from './admin-group-message.schema';

function preview(
  expoId: string,
  targets: ReadonlyArray<Record<string, unknown>>,
) {
  return {
    requesterUserId: 17,
    expoId,
    requestId: randomUUID(),
    applicationCount: targets.length,
    targetFingerprint: 'a'.repeat(64),
    channel: 'SMS' as const,
    targets,
  };
}

function preregistrationTarget(
  expoId: string,
  source: 'APPLICATION' | 'RESERVATION',
  suffix: string,
) {
  const ledgerKey = `${source}:${expoId}:${suffix}`;
  return {
    targetId: ledgerKey,
    ledgerKey,
    ...(source === 'APPLICATION' ? { participantId: 42 } : {}),
    recipientPhone: '01012345678',
    content: '사전등록 안내',
  };
}

function eventFrom(mutation: GroupMessageHistoryMutation): unknown {
  const payload = mutation.arguments[0].slice(
    mutation.arguments[0].indexOf('|') + 1,
  );
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

describe('preregistration group-message contract', () => {
  it('accepts APPLICATION and RESERVATION ledger identities without program fields', () => {
    const expoId = randomUUID();
    const reservationSuffix = 'r'.repeat(111);
    const application = preregistrationTarget(
      expoId,
      'APPLICATION',
      '9223372036854775807',
    );
    const reservation = preregistrationTarget(
      expoId,
      'RESERVATION',
      reservationSuffix,
    );
    const opaqueReservation = preregistrationTarget(
      expoId,
      'RESERVATION',
      '  external request  ',
    );

    const parsedApplication = createGroupMessagePreviewSchema.parse(
      preview(expoId, [application]),
    );
    const parsedReservation = createGroupMessagePreviewSchema.parse(
      preview(expoId, [reservation]),
    );
    const parsedOpaqueReservation = createGroupMessagePreviewSchema.parse(
      preview(expoId, [opaqueReservation]),
    );

    expect(parsedApplication.targets[0]).toMatchObject({
      targetId: application.ledgerKey,
      ledgerKey: application.ledgerKey,
      participantId: 42,
    });
    expect(parsedApplication.targets[0]).not.toHaveProperty('applicationId');
    expect(parsedApplication.targets[0]).not.toHaveProperty('programType');
    expect(parsedReservation.targets[0]).toMatchObject({
      targetId: reservation.ledgerKey,
      ledgerKey: reservation.ledgerKey,
    });
    expect(reservation.ledgerKey).toHaveLength(160);
    expect(parsedReservation.targets[0]).not.toHaveProperty('applicationId');
    expect(parsedReservation.targets[0]).not.toHaveProperty('participantId');
    expect(parsedOpaqueReservation.targets[0]).toMatchObject({
      targetId: opaqueReservation.ledgerKey,
      ledgerKey: opaqueReservation.ledgerKey,
    });
  });

  it('rejects foreign, malformed, and mixed program/preregistration targets', () => {
    const expoId = randomUUID();
    const foreignExpoId = randomUUID();
    const application = preregistrationTarget(expoId, 'APPLICATION', '1');
    const program = {
      targetId: 'program-target',
      applicationId: randomUUID(),
      participantId: 1,
      programType: 'STANDARD',
      recipientPhone: '01012345678',
      content: '기존 프로그램 안내',
    };

    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [{ ...application, targetId: 'different-target' }]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [{ ...application, applicationId: randomUUID() }]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [
          preregistrationTarget(foreignExpoId, 'APPLICATION', '1'),
        ]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [
          preregistrationTarget(expoId, 'APPLICATION', '9223372036854775808'),
        ]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [
          preregistrationTarget(expoId, 'RESERVATION', 'x'.repeat(112)),
        ]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [application, program]),
      ).success,
    ).toBe(false);

    const applicationWithoutParticipant = {
      targetId: application.targetId,
      ledgerKey: application.ledgerKey,
      recipientPhone: application.recipientPhone,
      content: application.content,
    };
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [applicationWithoutParticipant]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [
          {
            ...preregistrationTarget(expoId, 'RESERVATION', 'request'),
            participantId: 1,
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [{ ...application, programType: 'STANDARD' }]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [{ ...application, applicationId: null }]),
      ).success,
    ).toBe(false);
    for (const invalidId of ['0', '-1', '1.5'])
      expect(
        createGroupMessagePreviewSchema.safeParse(
          preview(expoId, [
            preregistrationTarget(expoId, 'APPLICATION', invalidId),
          ]),
        ).success,
      ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [application, { ...application }]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [{ ...application, recipientPhone: '0101234' }]),
      ).success,
    ).toBe(false);
    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, [
          { ...application, recipientPhone: undefined, content: undefined },
        ]),
      ).success,
    ).toBe(false);
  });

  it('accepts at most 5,000 preregistration ledger rows', () => {
    const expoId = randomUUID();
    const targets = Array.from({ length: 5_001 }, (_, index) =>
      preregistrationTarget(expoId, 'APPLICATION', String(index + 1)),
    );

    expect(
      createGroupMessagePreviewSchema.safeParse(
        preview(expoId, targets.slice(0, 5_000)),
      ).success,
    ).toBe(true);
    expect(
      createGroupMessagePreviewSchema.safeParse(preview(expoId, targets))
        .success,
    ).toBe(false);
  });

  it('parses a stored preregistration job and a 100-character legacy program target', () => {
    const expoId = randomUUID();
    const job = (targets: ReadonlyArray<Record<string, unknown>>) => ({
      jobId: 'a'.repeat(64),
      previewId: randomUUID(),
      requesterUserId: 17,
      expoId,
      applicationCount: targets.length,
      targetFingerprint: 'b'.repeat(64),
      channel: 'SMS',
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      authorizedUntil: new Date().toISOString(),
      targets,
    });
    const preregistration = preregistrationTarget(
      expoId,
      'RESERVATION',
      'non-uuid-request:with-colon',
    );
    const parsedPreregistration = parseGroupMessageJob(
      JSON.stringify(job([{ ...preregistration, status: 'PENDING' }])),
    );
    const parsedLegacy = parseGroupMessageJob(
      JSON.stringify(
        job([
          {
            targetId: 'p'.repeat(100),
            applicationId: randomUUID(),
            programType: 'STANDARD',
            recipientPhone: '01012345678',
            content: '기존 대상',
            status: 'PENDING',
          },
        ]),
      ),
    );
    const trimmedLegacy = createGroupMessagePreviewSchema.parse(
      preview(expoId, [
        {
          targetId: '  legacy program  ',
          applicationId: randomUUID(),
          programType: 'STANDARD',
          recipientPhone: '01012345678',
          content: '기존 대상',
        },
      ]),
    );

    expect(parsedPreregistration.targets[0]).toMatchObject({
      ledgerKey: preregistration.ledgerKey,
      targetId: preregistration.ledgerKey,
    });
    expect(parsedPreregistration.targets[0]).not.toHaveProperty(
      'applicationId',
    );
    expect(parsedLegacy.targets[0]).toMatchObject({
      targetId: 'p'.repeat(100),
      programType: 'STANDARD',
    });
    expect(trimmedLegacy.targets[0]?.targetId).toBe('legacy program');
    const foreignLedgerKey = `RESERVATION:${randomUUID()}:foreign-request`;
    expect(() =>
      parseGroupMessageJob(
        JSON.stringify(
          job([
            {
              ...preregistration,
              ledgerKey: foreignLedgerKey,
              targetId: foreignLedgerKey,
              status: 'PENDING',
            },
          ]),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseGroupMessageJob(
        JSON.stringify(
          job([
            { ...preregistration, status: 'PENDING' },
            {
              targetId: 'legacy',
              applicationId: randomUUID(),
              programType: 'STANDARD',
              recipientPhone: '01012345678',
              content: '기존 대상',
              status: 'PENDING',
            },
          ]),
        ),
      ),
    ).toThrow();
  });

  it('marks preregistration history explicitly while preserving legacy program history', () => {
    const expoId = randomUUID();
    const buildJob = (target: Record<string, unknown>): GroupMessageJob =>
      parseGroupMessageJob(
        JSON.stringify({
          jobId: 'c'.repeat(64),
          previewId: randomUUID(),
          requesterUserId: 17,
          expoId,
          applicationCount: 1,
          targetFingerprint: 'd'.repeat(64),
          channel: 'SMS',
          status: 'QUEUED',
          createdAt: new Date().toISOString(),
          authorizedUntil: new Date().toISOString(),
          targets: [{ ...target, status: 'PENDING' }],
        }),
      );
    const preregistration = eventFrom(
      groupMessageHistoryMutation(
        buildJob(preregistrationTarget(expoId, 'APPLICATION', '1')),
        'REQUESTED',
        60,
      ),
    );
    const legacy = eventFrom(
      groupMessageHistoryMutation(
        buildJob({
          targetId: 'program',
          applicationId: randomUUID(),
          programType: 'TRAINING',
          recipientPhone: '01012345678',
          content: '기존 프로그램 안내',
        }),
        'REQUESTED',
        60,
      ),
    );

    expect(preregistration).toMatchObject({
      targetScope: { source: 'PREREGISTRATION', programTypes: [] },
    });
    expect(legacy).toMatchObject({
      targetScope: { programTypes: ['TRAINING'] },
    });
    expect(legacy).not.toHaveProperty('targetScope.source');
  });
});
