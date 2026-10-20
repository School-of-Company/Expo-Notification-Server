import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ExpoNameProvider } from '../common/expo-name.provider';
import { kakaoOptionsFor } from '../sms/kakao-message';
import { KakaoSenderProvider } from '../sms/kakao-sender.provider';
import { PromotionApplicationProvider } from './promotion-application.provider';
import { promotionMessage } from './promotion-message';
import { PromotionSolapiProvider } from './promotion-solapi.provider';
import type { PromotionDelivery } from './promotion-solapi.provider';
import { PromotionStore } from './promotion.store';
import {
  PromotionInvalidCheckError,
  PromotionRetryError,
} from './promotion.schema';
import type { PromotionEvent, PromotionRecord } from './promotion.schema';

export type PromotionResumeResult =
  'RESUMED' | 'NOT_FOUND' | 'NOT_RESUMABLE' | 'BUSY';

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PromotionStore,
    private readonly application: PromotionApplicationProvider,
    private readonly sender: PromotionSolapiProvider,
    private readonly expoNames: ExpoNameProvider,
    private readonly kakao: KakaoSenderProvider,
  ) {}

  async handle(event: PromotionEvent): Promise<void> {
    await this.store.enqueue(event);
    // 복구 보류 중에는 수신 기록만 남기고 Kafka ACK한다. 발송은 공급자 대조 뒤 보류를 풀 때 스케줄러가 한다.
    if (this.held) return;
    await this.process(event.eventId);
  }

  get held(): boolean {
    return this.config.promotion?.recoveryHold === true;
  }

  // #32 messageId 없는 UNKNOWN/SENDING과 OPERATIONS만 승인 근거와 함께 PENDING으로 되돌린다.
  // 목록에 없음만으로 미접수를 판정하지 않으므로, 근거 확인은 승인 담당자 책임이고 여기서는 이력만 남긴다.
  async resume(
    id: string,
    approvalRef: string,
  ): Promise<PromotionResumeResult> {
    const token = await this.store.claim(id);
    if (!token) return 'BUSY';
    try {
      const record = await this.store.get(id);
      if (!record) return 'NOT_FOUND';
      const resumable =
        record.status === 'OPERATIONS' ||
        ((record.status === 'UNKNOWN' || record.status === 'SENDING') &&
          !record.messageId);
      if (!resumable) return 'NOT_RESUMABLE';
      const fromStatus = record.status as 'OPERATIONS' | 'UNKNOWN' | 'SENDING';
      await this.store.save(
        {
          event: record.event,
          status: 'PENDING',
          failures: 0,
          reason: 'MANUAL_RESUME',
          resumes: [
            ...(record.resumes ?? []),
            {
              at: new Date().toISOString(),
              approvalRef,
              fromStatus,
              fromAttemptId: record.attemptId,
              fromReason: record.reason,
            },
          ],
        },
        token,
      );
      this.logger.warn({
        message: '승급 안내 수동 재개',
        eventId: id,
        fromStatus,
        held: this.held,
      });
      return 'RESUMED';
    } finally {
      await this.store.release(id, token);
    }
  }

  async process(id: string, messageId?: string): Promise<void> {
    const token = await this.store.claim(id);
    if (!token) return;
    try {
      const record = await this.store.get(id);
      if (!record) return;
      if (
        messageId &&
        record.status !== 'ACCEPTED' &&
        record.status !== 'SENDING' &&
        record.status !== 'UNKNOWN'
      )
        return;
      if (
        record.status === 'ACCEPTED' ||
        (messageId &&
          (record.status === 'SENDING' || record.status === 'UNKNOWN'))
      ) {
        const result = await this.sender.delivery(
          record,
          messageId ?? record.messageId ?? '',
        );
        if (!result) throw new PromotionRetryError();
        await this.store.save(this.deliveryRecord(record, result), token);
        return;
      }
      if (record.status !== 'PENDING') return;
      // 대조 전 backlog 재처리 금지. 결과 조회(위)는 발송하지 않으므로 보류 중에도 허용한다.
      if (this.held) return;
      let check: Awaited<ReturnType<PromotionApplicationProvider['check']>>;
      try {
        check = await this.application.check(record.event);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error instanceof PromotionInvalidCheckError) {
          await this.store.save(
            {
              ...record,
              status: 'OPERATIONS',
              reason: 'INVALID_CHECK_RESPONSE',
            },
            token,
          );
          this.logger.error({
            message: '승급 안내 확인 응답 계약 위반 운영 확인 필요',
            eventId: id,
          });
          return;
        }
        await this.store.save(
          { ...record, reason: 'LOOKUP_UNAVAILABLE' },
          token,
        );
        return;
      }
      if (!check.eligible) {
        await this.store.save(
          { ...record, status: 'SKIPPED', reason: check.reason },
          token,
        );
        return;
      }
      if (!check.representativePhoneNumber) {
        await this.store.save(
          {
            ...record,
            status: 'OPERATIONS',
            reason: 'MISSING_REPRESENTATIVE_PHONE',
          },
          token,
        );
        this.logger.error({
          message: '승급 안내 수신번호 운영 확인 필요',
          eventId: id,
        });
        return;
      }
      const { text, variables } = promotionMessage(
        await this.expoNames.titleOf(check.expoId),
        check,
      );
      if (Buffer.byteLength(text, 'utf8') > 2000) {
        await this.store.save(
          { ...record, status: 'OPERATIONS', reason: 'MESSAGE_TOO_LONG' },
          token,
        );
        return;
      }
      const attemptId = randomUUID();
      const sending: PromotionRecord = {
        ...record,
        status: 'SENDING',
        attemptId,
        attemptedAt: new Date().toISOString(),
        reason: undefined,
        groupId: undefined,
        messageId: undefined,
        providerCode: undefined,
      };
      // 알림톡 본문은 1,000자까지다. 긴 장소·주소로 넘으면 카톡은 빼고 문자로만 보낸다.
      const kakaoOptions =
        Array.from(text).length <= 1_000
          ? kakaoOptionsFor(
              this.config,
              this.config.kakao?.auto.promotion,
              variables,
            )
          : undefined;
      // Persist before the irreversible request; a crash or Redis failure must never reopen sending.
      await this.store.save(sending, token);
      const message = {
        to: check.representativePhoneNumber,
        from:
          check.programType === 'TRAINING'
            ? this.config.sms.fromTraineeNumber
            : this.config.sms.fromStandardNumber,
        text,
      };
      const receipt = await this.sender.send(sending, message);
      switch (receipt.kind) {
        case 'accepted':
          await this.store.save(
            {
              ...sending,
              status: 'ACCEPTED',
              groupId: receipt.groupId,
              messageId: receipt.messageId,
            },
            token,
          );
          // ACCEPTED를 저장한 뒤에 보낸다. 원장은 문자 messageId만 추적하고, 카톡 실패는 재시도하지 않는다.
          if (kakaoOptions) {
            await this.kakao.send([{ ...message, kakaoOptions }], {
              eventId: id,
              attemptId,
            });
          }
          return;
        case 'rejected':
          await this.store.save(
            this.failedRecord(sending, receipt.code),
            token,
          );
          return;
        case 'unknown':
          await this.store.save(
            {
              ...sending,
              status: 'UNKNOWN',
              reason: 'PROVIDER_ACCEPTANCE_UNKNOWN',
            },
            token,
          );
          this.logger.error({
            message: '승급 문자 공급자 접수 여부 운영 확인 필요',
            eventId: id,
          });
          return;
        default: {
          const exhaustive: never = receipt;
          return exhaustive;
        }
      }
    } finally {
      await this.store.release(id, token);
    }
  }

  private failedRecord(record: PromotionRecord, code: string): PromotionRecord {
    const failures = record.failures + 1;
    if (failures >= 5)
      this.logger.error({
        message: '승급 문자 5회 실패 운영 확인 필요',
        eventId: record.event.eventId,
      });
    return {
      ...record,
      failures,
      providerCode: code,
      status: failures >= 5 ? 'OPERATIONS' : 'PENDING',
      reason: 'PROVIDER_CONFIRMED_FAILURE',
    };
  }

  private deliveryRecord(
    record: PromotionRecord,
    result: PromotionDelivery,
  ): PromotionRecord {
    const updated = {
      ...record,
      groupId: result.groupId,
      messageId: result.messageId,
      providerCode: result.code,
    };
    switch (result.kind) {
      case 'delivered':
        return { ...updated, status: 'DELIVERED', reason: undefined };
      case 'pending':
        return { ...updated, status: 'ACCEPTED', reason: undefined };
      case 'failed':
        return this.failedRecord(updated, result.code);
      default: {
        const exhaustive: never = result.kind;
        return exhaustive;
      }
    }
  }
}
