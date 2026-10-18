import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { maskPhone } from '../common/mask-phone';
import type { KakaoOptions } from './kakao-message';
import { solapiRequest } from './solapi-request';
import type { OutgoingSms } from './sms-sender.provider';

export interface OutgoingKakao extends OutgoingSms {
  kakaoOptions: KakaoOptions;
}

const sendResultSchema = z.object({
  failedMessageList: z.array(z.object({ to: z.string() })),
});
// 문자 발송(최대 15초)과 합쳐도 kafkajs 기본 sessionTimeout(30초) 안에 끝나야 한다.
const KAKAO_SEND_TIMEOUT_MS = 5_000;

/**
 * 문자가 접수된 뒤에 같은 text로 보내는 카톡. 성공·실패는 문자로 판정하므로 결과를 돌려주지 않고,
 * 실패는 경고만 남기고 던지지 않는다 — 던지면 Kafka 재전달·재시도로 이어진다.
 */
@Injectable()
export class KakaoSenderProvider {
  private readonly logger = new Logger(KakaoSenderProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(
    messages: OutgoingKakao[],
    customFields?: Record<string, string>,
  ): Promise<void> {
    if (messages.length === 0) return;
    let failedTo = messages.map((message) => message.to);
    try {
      const response = await solapiRequest(
        this.config,
        '/messages/v4/send-many/detail',
        {
          messages: messages.map((message) => ({
            ...message,
            ...(customFields && { customFields }),
          })),
        },
        KAKAO_SEND_TIMEOUT_MS,
      );
      if (response.ok) {
        const parsed = sendResultSchema.safeParse(await response.json());
        if (parsed.success)
          failedTo = parsed.data.failedMessageList.map((failed) => failed.to);
      }
    } catch {
      // 결과 불명도 실패로 기록만 한다.
    }
    if (failedTo.length > 0) {
      this.logger.warn(
        `카톡 발송 실패 또는 결과 불명(문자는 접수됨): failed=${failedTo.length}/${messages.length}, to=${failedTo.map(maskPhone).join(',')}`,
      );
    }
  }
}
