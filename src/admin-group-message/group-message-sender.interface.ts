import type { AppConfig } from '../config/app-config';
import type { GroupMessageJob } from './admin-group-message.schema';

export const GROUP_MESSAGE_SENDER = 'GROUP_MESSAGE_SENDER';

export type GroupMessageTargetRecord = GroupMessageJob['targets'][number];

export type GroupMessageReceipt =
  | { kind: 'accepted'; groupId: string; messageId: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown' };

export type GroupMessageDelivery =
  | { kind: 'delivered'; code: string }
  | { kind: 'failed'; code: string }
  | { kind: 'pending'; code: string };

export interface GroupMessageSender {
  send(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<GroupMessageReceipt>;
  delivery(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<GroupMessageDelivery | null>;
}

export function senderPhone(
  config: AppConfig,
  target: GroupMessageTargetRecord,
): string {
  return target.programType === 'TRAINING'
    ? config.sms.fromTraineeNumber
    : config.sms.fromStandardNumber;
}
