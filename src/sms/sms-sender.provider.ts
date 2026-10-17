import { Inject, Injectable } from '@nestjs/common';
import { SolapiMessageService } from 'solapi';
import { z } from 'zod';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import type { KakaoOptions } from './kakao-message';
import { solapiRequest } from './solapi-request';
import { SOLAPI_CLIENT } from './sms.constants';

export interface OutgoingSms {
  to: string;
  from: string;
  text: string;
  kakaoOptions?: KakaoOptions;
}

export interface SmsSendResult {
  total: number;
  failedTo: string[];
}

export class SmsDeliveryError extends Error {}

/**
 * Kafka 이벤트 발송 결과.
 * - `rejected`: 공급자가 한 건도 접수하지 않았음이 확실하다 (명시적 거부·연결 수립 실패). 다시 보내도 중복이 아니다.
 * - `unknown`: 접수됐을 수 있다 (timeout·연결 끊김·5xx·해석 불가 응답). 다시 보내면 중복될 수 있다.
 */
export type SmsReceipt =
  | { readonly kind: 'accepted'; readonly failedTo: string[] }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'unknown' };

const sendManyResultSchema = z.object({
  groupInfo: z.object({
    count: z.object({
      total: z.number().int(),
      registeredSuccess: z.number().int().nonnegative(),
      registeredFailed: z.number().int().nonnegative(),
    }),
  }),
  failedMessageList: z.array(
    z.object({ to: z.string(), statusCode: z.string().optional() }),
  ),
});

// 요청이 서버에 닿기 전에 실패한 연결 오류만 미접수로 본다. 그 외 전송 오류는 접수 여부를 알 수 없다.
const NOT_CONNECTED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// kafkajs는 eachMessage 동안 heartbeat를 보내지 않는다. 기본 sessionTimeout(30초)보다 짧아야 리밸런스로 같은 이벤트가 넘어가지 않는다.
// ponytail: CUSTOM 최대 1000건 한 요청 기준 고정값. 대량 접수가 자주 넘기면 설정으로 뺀다.
const EVENT_SEND_TIMEOUT_MS = 15_000;

@Injectable()
export class SmsSenderProvider {
  constructor(
    @Inject(SOLAPI_CLIENT) private readonly client: SolapiMessageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Kafka 이벤트 발송: SDK 내부 재시도를 피해 HTTP 요청을 정확히 한 번만 보낸다. */
  async deliver(eventId: string, messages: OutgoingSms[]): Promise<SmsReceipt> {
    let response: Response;
    try {
      response = await solapiRequest(
        this.config,
        '/messages/v4/send-many/detail',
        {
          messages: messages.map((message) => ({
            ...message,
            customFields: { eventId },
          })),
        },
        EVENT_SEND_TIMEOUT_MS,
      );
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } } | null)?.cause
        ?.code;
      return typeof code === 'string' && NOT_CONNECTED_CODES.has(code)
        ? { kind: 'rejected', code }
        : { kind: 'unknown' };
    }
    // 408은 요청을 받다 끊긴 것이라 접수 여부를 알 수 없다.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      return { kind: 'rejected', code: `HTTP_${response.status}` };
    if (!response.ok) return { kind: 'unknown' };
    try {
      const parsed = sendManyResultSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: 'unknown' };
      const { groupInfo, failedMessageList } = parsed.data;
      const { total, registeredSuccess, registeredFailed } = groupInfo.count;
      if (
        total !== messages.length ||
        registeredSuccess + registeredFailed !== total ||
        failedMessageList.length !== registeredFailed
      )
        return { kind: 'unknown' };
      if (registeredSuccess === 0)
        return {
          kind: 'rejected',
          code: failedMessageList[0]?.statusCode ?? 'ALL_FAILED',
        };
      return {
        kind: 'accepted',
        failedTo: failedMessageList.map((failed) => failed.to),
      };
    } catch {
      return { kind: 'unknown' };
    }
  }

  async send(messages: OutgoingSms[]): Promise<SmsSendResult> {
    try {
      const response = await this.client.send(messages);
      return {
        total: messages.length,
        failedTo: response.failedMessageList.map((failed) => failed.to),
      };
    } catch (error) {
      const failed = (error as { failedMessageList?: { to: string }[] })
        .failedMessageList;
      if (Array.isArray(failed)) {
        return { total: messages.length, failedTo: failed.map((m) => m.to) };
      }
      throw new SmsDeliveryError('sms gateway request failed');
    }
  }
}
