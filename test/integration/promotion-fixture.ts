import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  promotionEventSchema,
  promotionCheckSchema,
} from '../../src/promotion/promotion.schema';
import type {
  PromotionEvent,
  PromotionCheck,
} from '../../src/promotion/promotion.schema';

export function promoted(): PromotionEvent {
  return promotionEventSchema.parse({
    version: 1,
    eventId: randomUUID(),
    applicationId: randomUUID(),
    expoId: randomUUID(),
    participantId: 2,
    programType: 'STANDARD',
    programId: 3,
  });
}

export function eligible(event: PromotionEvent): PromotionCheck {
  return promotionCheckSchema.parse({
    ...event,
    eligible: true,
    status: 'CONFIRMED',
    representativePhoneNumber: '01000000000',
    participantName: '동행자',
    programName: '미래 수업',
    startedAt: '2026-10-13T01:00:00Z',
    endedAt: '2026-10-13T02:00:00Z',
    location: null,
    applicationLookupUrl: null,
  });
}

export class PromotionHttpFixture {
  private server?: Server;
  url = '';
  readonly checks: PromotionEvent[] = [];
  readonly sms: {
    to: string;
    from: string;
    text: string;
    eventId: string;
    attemptId: string;
    messageId: string;
  }[] = [];
  checkResponse: (event: PromotionEvent) => PromotionCheck = eligible;
  lookupFailures = 0;
  sendMode: 'accepted' | 'rejected' | 'timeout' | 'malformed' | '503' =
    'accepted';
  deliveryCode = '2000';
  deliveryStatus = 'PENDING';
  deliveryEventId?: string;
  deliveryMissing = false;
  resultFailures = 0;

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.respond(request, response).catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error('fixture failure'),
        );
      });
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing fixture port');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  private async respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const raw of request) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array) && typeof chunk !== 'string')
        throw new Error('invalid request chunk');
      chunks.push(Buffer.from(chunk));
    }
    const body: unknown = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(request.url ?? '/', 'http://fixture');
    response.setHeader('Content-Type', 'application/json');
    if (path.pathname === '/internal/program-promotions/check') {
      if (request.headers['x-internal-token'] !== 'a'.repeat(32)) {
        response.writeHead(401).end('{}');
        return;
      }
      const event = promotionEventSchema.parse(body);
      this.checks.push(event);
      if (this.lookupFailures > 0) {
        this.lookupFailures--;
        response.writeHead(503).end('{}');
        return;
      }
      response.end(JSON.stringify(this.checkResponse(event)));
      return;
    }
    const auth =
      /^HMAC-SHA256 apiKey=key, date=(.+), salt=(.+), signature=(.+)$/.exec(
        String(request.headers.authorization),
      );
    if (
      !auth ||
      createHmac('sha256', 'secret')
        .update(auth[1] + auth[2])
        .digest('hex') !== auth[3]
    ) {
      response.writeHead(401).end('{}');
      return;
    }
    if (path.pathname === '/messages/v4/send-many/detail') {
      const parsed = z
        .object({
          showMessageList: z.literal(true),
          allowDuplicates: z.literal(false),
          messages: z
            .array(
              z.object({
                to: z.string(),
                from: z.string(),
                text: z.string(),
                customFields: z.object({
                  eventId: z.uuid(),
                  attemptId: z.uuid(),
                }),
              }),
            )
            .length(1),
        })
        .parse(body);
      const message = parsed.messages[0];
      if (!message) throw new Error('missing synthetic message');
      const messageId = `M-synthetic-${this.sms.length}`;
      this.sms.push({ ...message, ...message.customFields, messageId });
      if (this.sendMode === 'timeout') {
        return;
      }
      if (this.sendMode === '503') {
        response.writeHead(503).end('{}');
        return;
      }
      if (this.sendMode === 'malformed') {
        response.end('{}');
        return;
      }
      const failed = this.sendMode === 'rejected';
      response.end(
        JSON.stringify({
          groupInfo: {
            groupId: 'G-synthetic',
            count: {
              total: 1,
              registeredSuccess: failed ? 0 : 1,
              registeredFailed: failed ? 1 : 0,
            },
          },
          failedMessageList: failed
            ? [{ to: message.to, messageId, statusCode: '3040' }]
            : [],
          messageList: failed ? [] : [{ messageId, statusCode: '2000' }],
        }),
      );
      return;
    }
    if (path.pathname === '/messages/v4/list') {
      if (this.resultFailures > 0) {
        this.resultFailures--;
        response.writeHead(503).end('{}');
        return;
      }
      const message = this.sms.find(
        (item) => item.messageId === path.searchParams.get('messageId'),
      );
      response.end(
        JSON.stringify({
          messageList:
            message && !this.deliveryMissing
              ? {
                  [message.messageId]: {
                    messageId: message.messageId,
                    groupId: 'G-synthetic',
                    status: this.deliveryStatus,
                    statusCode: this.deliveryCode,
                    customFields: {
                      eventId: this.deliveryEventId ?? message.eventId,
                      attemptId: message.attemptId,
                    },
                  },
                }
              : {},
        }),
      );
      return;
    }
    response.writeHead(404).end('{}');
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
