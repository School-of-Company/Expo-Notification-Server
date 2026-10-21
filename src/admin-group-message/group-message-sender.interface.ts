import type { AppConfig } from '../config/app-config';
import type { TemplateVariables } from '../sms/kakao-message';
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

export type GroupKakaoTemplate = NonNullable<
  NonNullable<AppConfig['adminGroupMessaging']>['kakao']
>['templates'][number];

// 승인 변수명 → 값. 받는 사람별 값(variableMapping)에 모두 같은 값(fixedVariables)을 더한다. 값이 빠지면 그 의미 이름을 돌려준다.
export function groupTemplateVariables(
  template: GroupKakaoTemplate,
  values: GroupMessageTargetRecord['templateVariables'],
): { variables: TemplateVariables } | { missing: string } {
  const variables: TemplateVariables = { ...template.fixedVariables };
  for (const [semanticName, providerName] of Object.entries(
    template.variableMapping,
  )) {
    const value = values?.[semanticName as keyof typeof values];
    if (value === undefined) return { missing: semanticName };
    variables[providerName] = value;
  }
  return { variables };
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
  const resolved = groupTemplateVariables(template, target.templateVariables);
  if ('missing' in resolved) return undefined;
  return {
    to: target.recipientPhone,
    from: senderPhone(config, target),
    text: target.content,
    kakaoOptions: {
      pfId: kakao.pfId,
      templateId: template.providerTemplateId,
      variables: resolved.variables,
      disableSms: true,
    },
  };
}
