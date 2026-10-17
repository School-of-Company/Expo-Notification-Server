import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ExpoNameProvider } from '../common/expo-name.provider';
import { kakaoOptionsFor } from '../sms/kakao-message';
import { PromotionApplicationProvider } from './promotion-application.provider';
import { promotionMessage } from './promotion-message';
import { PromotionSolapiProvider } from './promotion-solapi.provider';
import type { PromotionDelivery } from './promotion-solapi.provider';
import { PromotionStore } from './promotion.store';
import { PromotionRetryError } from './promotion.schema';
import type { PromotionEvent, PromotionRecord } from './promotion.schema';

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PromotionStore,
    private readonly application: PromotionApplicationProvider,
    private readonly sender: PromotionSolapiProvider,
    private readonly expoNames: ExpoNameProvider,
  ) {}

  async handle(event: PromotionEvent): Promise<void> {
    await this.store.enqueue(event);
    await this.process(event.eventId);
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
      let check: Awaited<ReturnType<PromotionApplicationProvider['check']>>;
      try {
        check = await this.application.check(record.event);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
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
      const sending: PromotionRecord = {
        ...record,
        status: 'SENDING',
        attemptId: randomUUID(),
        attemptedAt: new Date().toISOString(),
        reason: undefined,
        groupId: undefined,
        messageId: undefined,
        providerCode: undefined,
      };
      // 알림톡 본문은 1,000자까지다. 긴 장소·주소로 넘으면 카톡 없이 문자로만 보낸다.
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
      const receipt = await this.sender.send(sending, {
        to: check.representativePhoneNumber,
        from:
          check.programType === 'TRAINING'
            ? this.config.sms.fromTraineeNumber
            : this.config.sms.fromStandardNumber,
        text,
        ...(kakaoOptions && { kakaoOptions }),
      });
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
