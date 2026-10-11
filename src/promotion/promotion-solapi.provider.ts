import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import type { OutgoingSms } from '../sms/sms-sender.provider';
import type { PromotionRecord } from './promotion.schema';

const receiptSchema = z.object({
  groupInfo: z.object({
    groupId: z.string().min(1),
    count: z.object({
      total: z.literal(1),
      registeredSuccess: z.number().int(),
      registeredFailed: z.number().int(),
    }),
  }),
  failedMessageList: z.array(
    z.object({
      to: z.string(),
      messageId: z.string().min(1),
      statusCode: z.string(),
    }),
  ),
  messageList: z
    .array(z.object({ messageId: z.string().min(1), statusCode: z.string() }))
    .optional(),
});
const resultSchema = z.object({
  messageList: z.record(
    z.string(),
    z.object({
      messageId: z.string(),
      groupId: z.string(),
      status: z.string(),
      statusCode: z.string().nullable(),
      customFields: z.object({ eventId: z.string(), attemptId: z.string() }),
    }),
  ),
});
export type PromotionReceipt =
  | {
      readonly kind: 'accepted';
      readonly groupId: string;
      readonly messageId: string;
    }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'unknown' };
export type PromotionDelivery = {
  readonly groupId: string;
  readonly messageId: string;
  readonly code: string;
  readonly kind: 'pending' | 'delivered' | 'failed';
};

@Injectable()
export class PromotionSolapiProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async request(path: string, body?: unknown): Promise<Response> {
    const date = new Date().toISOString();
    const salt = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', this.config.sms.apiSecret)
      .update(date + salt)
      .digest('hex');
    // SDK 6.0.1 retries transport errors/503 internally. A send must have exactly one HTTP attempt.
    return fetch(`https://api.solapi.com${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `HMAC-SHA256 apiKey=${this.config.sms.apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  }

  async send(
    record: PromotionRecord,
    message: OutgoingSms,
  ): Promise<PromotionReceipt> {
    try {
      const response = await this.request('/messages/v4/send-many/detail', {
        messages: [
          {
            ...message,
            customFields: {
              eventId: record.event.eventId,
              attemptId: record.attemptId,
            },
          },
        ],
        showMessageList: true,
        allowDuplicates: false,
      });
      if (!response.ok) return { kind: 'unknown' };
      const body: unknown = await response.json();
      const parsed = receiptSchema.safeParse(body);
      if (!parsed.success) return { kind: 'unknown' };
      const { groupInfo, failedMessageList, messageList } = parsed.data;
      const failure = failedMessageList[0];
      if (
        groupInfo.count.registeredFailed === 1 &&
        groupInfo.count.registeredSuccess === 0 &&
        failedMessageList.length === 1 &&
        failure?.to === message.to
      ) {
        return { kind: 'rejected', code: failure.statusCode };
      }
      const accepted = messageList?.[0];
      if (
        groupInfo.count.registeredSuccess === 1 &&
        groupInfo.count.registeredFailed === 0 &&
        failedMessageList.length === 0 &&
        messageList?.length === 1 &&
        accepted?.statusCode === '2000'
      ) {
        return {
          kind: 'accepted',
          groupId: groupInfo.groupId,
          messageId: accepted.messageId,
        };
      }
      return { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  async delivery(
    record: PromotionRecord,
    messageId: string,
  ): Promise<PromotionDelivery | null> {
    try {
      const response = await this.request(
        `/messages/v4/list?messageId=${encodeURIComponent(messageId)}`,
      );
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const parsed = resultSchema.safeParse(body);
      if (!parsed.success) return null;
      const message = parsed.data.messageList[messageId];
      if (
        !message ||
        message.messageId !== messageId ||
        message.customFields.eventId !== record.event.eventId ||
        message.customFields.attemptId !== record.attemptId ||
        (record.groupId && message.groupId !== record.groupId)
      )
        return null;
      const code = message.statusCode ?? '';
      return {
        groupId: message.groupId,
        messageId,
        code,
        kind:
          message.status === 'COMPLETE' && code === '4000'
            ? 'delivered'
            : message.status === 'COMPLETE' && /^[345]\d{3}$/.test(code)
              ? 'failed'
              : 'pending',
      };
    } catch {
      return null;
    }
  }
}
