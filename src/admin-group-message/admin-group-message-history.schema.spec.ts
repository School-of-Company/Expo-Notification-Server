import { randomUUID } from 'node:crypto';
import { groupMessageJobSchema } from './admin-group-message.schema';

describe('group message history compatibility', () => {
  it('parses jobs saved before applicationCount was recorded', () => {
    expect(
      groupMessageJobSchema.parse({
        jobId: 'a'.repeat(64),
        previewId: randomUUID(),
        requesterUserId: 1,
        expoId: randomUUID(),
        targetFingerprint: 'b'.repeat(64),
        channel: 'SMS',
        status: 'QUEUED',
        createdAt: new Date().toISOString(),
        authorizedUntil: new Date(Date.now() + 60_000).toISOString(),
        targets: [
          {
            targetId: 'target',
            applicationId: randomUUID(),
            programType: 'STANDARD',
            recipientPhone: '01012345678',
            content: '안내',
            status: 'PENDING',
          },
        ],
      }).applicationCount,
    ).toBeUndefined();
  });
});
