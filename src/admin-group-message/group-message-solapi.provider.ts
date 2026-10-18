import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../config/app-config.constants';
import { solapiRequest } from '../sms/solapi-request';
import type { AppConfig } from '../config/app-config';
import type { GroupMessageJob } from './admin-group-message.schema';
import {
  type GroupMessageDelivery,
  type GroupMessageReceipt,
  type GroupMessageSender,
  type GroupMessageTargetRecord,
  groupKakaoMessage,
  senderPhone,
} from './group-message-sender.interface';

const sendResultSchema = z.object({
  groupInfo: z.object({
    groupId: z.string().min(1).max(100),
    count: z.object({
      registeredSuccess: z.number().int().nonnegative(),
      registeredFailed: z.number().int().nonnegative(),
    }),
  }),
  failedMessageList: z.array(
    z.object({
      to: z.string().regex(/^0\d{8,10}$/),
      statusCode: z.string().min(1).max(50),
    }),
  ),
  messageList: z
    .array(
      z.object({
        messageId: z.string().min(1).max(100),
        statusCode: z.string().min(1).max(50),
      }),
    )
    .optional(),
});

const deliveryResultSchema = z.object({
  messageList: z.record(
    z.string(),
    z.object({
      messageId: z.string().min(1).max(100),
      groupId: z.string().min(1).max(100),
      to: z.string().regex(/^0\d{8,10}$/),
      status: z.string(),
      statusCode: z.string().nullable().optional(),
      customFields: z.object({
        jobId: z.string(),
        targetId: z.string(),
        attemptId: z.string(),
      }),
    }),
  ),
});

@Injectable()
export class GroupMessageSolapiProvider implements GroupMessageSender {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private request(path: string, body?: unknown): Promise<Response> {
    return solapiRequest(this.config, path, body);
  }

  async send(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<GroupMessageReceipt> {
    if (!target.recipientPhone || !target.content || !target.attemptId)
      return { kind: 'unknown' };
    // 카톡 건은 문자가 접수된 뒤 서비스가 따로 보낸다. 여기서는 KAKAO 설정이 온전한지만 확인한다.
    if (job.channel === 'KAKAO' && !groupKakaoMessage(this.config, job, target))
      return { kind: 'unknown' };
    try {
      const response = await this.request('/messages/v4/send-many/detail', {
        messages: [
          {
            to: target.recipientPhone,
            from: senderPhone(this.config, target),
            text: target.content,
            customFields: {
              jobId: job.jobId,
              targetId: target.targetId,
              attemptId: target.attemptId,
            },
          },
        ],
        showMessageList: true,
        allowDuplicates: false,
      });
      if (!response.ok) return { kind: 'unknown' };
      const parsed = sendResultSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: 'unknown' };
      const { groupInfo, failedMessageList, messageList } = parsed.data;
      const failed = failedMessageList[0];
      if (
        groupInfo.count.registeredFailed === 1 &&
        groupInfo.count.registeredSuccess === 0 &&
        failedMessageList.length === 1 &&
        failed?.to === target.recipientPhone
      )
        return { kind: 'rejected', code: failed.statusCode };
      const accepted = messageList?.[0];
      if (
        groupInfo.count.registeredSuccess === 1 &&
        groupInfo.count.registeredFailed === 0 &&
        failedMessageList.length === 0 &&
        messageList?.length === 1 &&
        accepted?.statusCode === '2000'
      )
        return {
          kind: 'accepted',
          groupId: groupInfo.groupId,
          messageId: accepted.messageId,
        };
      return { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  async delivery(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<GroupMessageDelivery | null> {
    if (!target.messageId || !target.attemptId) return null;
    try {
      const response = await this.request(
        `/messages/v4/list?messageId=${encodeURIComponent(target.messageId)}`,
      );
      if (!response.ok) return null;
      const parsed = deliveryResultSchema.safeParse(await response.json());
      if (!parsed.success) return null;
      const message = parsed.data.messageList[target.messageId];
      if (
        !message ||
        message.messageId !== target.messageId ||
        message.groupId !== target.groupId ||
        message.to !== target.recipientPhone ||
        message.customFields.jobId !== job.jobId ||
        message.customFields.targetId !== target.targetId ||
        message.customFields.attemptId !== target.attemptId
      )
        return null;
      const code = message.statusCode ?? '';
      if (message.status === 'COMPLETE' && code === '4000')
        return { kind: 'delivered', code };
      if (message.status === 'COMPLETE' && /^[345]\d{3}$/.test(code))
        return { kind: 'failed', code };
      return { kind: 'pending', code };
    } catch {
      return null;
    }
  }
}
