import type { AppConfig } from '../config/app-config';
import type { OutgoingKakao } from '../sms/kakao-sender.provider';
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

// KAKAO job의 카톡 건. 문자는 같은 content로 따로 나가므로 대체 문자는 끈다. 설정·변수가 모자라면 undefined.
export function groupKakaoMessage(
  config: AppConfig,
  job: GroupMessageJob,
  target: GroupMessageTargetRecord,
): OutgoingKakao | undefined {
  const kakao = config.adminGroupMessaging?.kakao;
  const template = kakao?.templates.find((item) => item.id === job.templateId);
  if (
    job.channel !== 'KAKAO' ||
    !kakao?.enabled ||
    !template ||
    !target.recipientPhone ||
    !target.content
  )
    return undefined;
  const variables: Record<string, string> = {};
  for (const [semanticName, providerName] of Object.entries(
    template.variableMapping,
  )) {
    const value =
      target.templateVariables?.[
        semanticName as keyof typeof target.templateVariables
      ];
    if (value === undefined) return undefined;
    variables[providerName] = value;
  }
  return {
    to: target.recipientPhone,
    from: senderPhone(config, target),
    text: target.content,
    kakaoOptions: {
      pfId: kakao.pfId,
      templateId: template.providerTemplateId,
      variables,
      disableSms: true,
    },
  };
}
