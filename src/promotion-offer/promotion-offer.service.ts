import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { PromotionSolapiProvider } from '../promotion/promotion-solapi.provider';
import type { PromotionDelivery } from '../promotion/promotion-solapi.provider';
import { PromotionOfferApplicationProvider } from './promotion-offer-application.provider';
import { promotionOfferMessage } from './promotion-offer-message';
import { PromotionOfferStore } from './promotion-offer.store';
import {
  promotionOfferSendingStaleMs,
  PromotionOfferRetryError,
} from './promotion-offer.schema';
import type {
  PromotionOfferEvent,
  PromotionOfferRecord,
} from './promotion-offer.schema';

// Sends a #144 participation offer at most once per attempt and reports what the provider really did. Unknown
// acceptance is never re-sent automatically; Application keeps the seats and never treats it as a decline.
@Injectable()
export class PromotionOfferService {
  private readonly logger = new Logger(PromotionOfferService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PromotionOfferStore,
    private readonly application: PromotionOfferApplicationProvider,
    private readonly sender: PromotionSolapiProvider,
  ) {}

  async handle(event: PromotionOfferEvent): Promise<void> {
    await this.store.enqueue(event);
    await this.process(event.eventId);
  }

  async process(id: string, messageId?: string): Promise<void> {
    const token = await this.store.claim(id);
    if (!token) return;
    try {
      let record = await this.store.get(id);
      if (!record) return;
      if (record.report) {
        record = await this.report(record, token);
        if (record.report) return;
      }
      if (
        record.status === 'ACCEPTED' ||
        (messageId &&
          (record.status === 'SENDING' || record.status === 'UNKNOWN'))
      ) {
        const result = await this.sender.delivery(
          record,
          messageId ?? record.messageId ?? '',
        );
        if (!result) throw new PromotionOfferRetryError();
        await this.finish(this.deliveryRecord(record, result), token);
        return;
      }
      if (record.status === 'SENDING') {
        // A crash or a failed result save left the attempt open; acceptance is unknown, so report it and never resend.
        if (
          Date.now() - Date.parse(record.attemptedAt ?? '') <
          promotionOfferSendingStaleMs
        )
          return;
        this.logger.error({
          message: '참여 제안 문자 공급자 접수 여부 운영 확인 필요',
          eventId: id,
        });
        await this.finish(
          {
            ...record,
            status: 'UNKNOWN',
            reason: 'PROVIDER_ACCEPTANCE_UNKNOWN',
            report: 'UNKNOWN',
          },
          token,
        );
        return;
      }
      if (record.status !== 'PENDING') return;
      let check: Awaited<
        ReturnType<PromotionOfferApplicationProvider['check']>
      >;
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
        // Outside the window Application reschedules a fresh event; a stale offer needs no report.
        await this.finish(
          {
            ...record,
            status: 'SKIPPED',
            reason: check.reason,
            report:
              check.reason === 'OUTSIDE_SEND_WINDOW' ? 'SKIPPED' : undefined,
          },
          token,
        );
        return;
      }
      const attemptedAt = new Date();
      if (attemptedAt.getTime() >= Date.parse(check.sendWindowEndsAt)) {
        await this.finish(
          {
            ...record,
            status: 'SKIPPED',
            reason: 'OUTSIDE_SEND_WINDOW',
            report: 'SKIPPED',
          },
          token,
        );
        return;
      }
      if (!check.representativePhoneNumber) {
        this.logger.error({
          message: '참여 제안 수신번호 운영 확인 필요',
          eventId: id,
        });
        await this.finish(
          {
            ...record,
            status: 'FAILED',
            reason: 'MISSING_REPRESENTATIVE_PHONE',
            report: 'FAILED',
          },
          token,
        );
        return;
      }
      const text = promotionOfferMessage(
        this.config.sms.expoName,
        check,
        attemptedAt,
      );
      if (Buffer.byteLength(text, 'utf8') > 2000) {
        await this.finish(
          {
            ...record,
            status: 'FAILED',
            reason: 'MESSAGE_TOO_LONG',
            report: 'FAILED',
          },
          token,
        );
        return;
      }
      const sending: PromotionOfferRecord = {
        ...record,
        status: 'SENDING',
        attemptId: randomUUID(),
        attemptedAt: attemptedAt.toISOString(),
        acceptedAt: undefined,
        reason: undefined,
        groupId: undefined,
        messageId: undefined,
        providerCode: undefined,
      };
      // Persist before the irreversible request; a crash or Redis failure must never reopen sending.
      await this.store.save(sending, token);
      const receipt = await this.sender.send(sending, {
        to: check.representativePhoneNumber,
        from: this.config.sms.fromStandardNumber,
        text,
      });
      switch (receipt.kind) {
        case 'accepted':
          await this.finish(
            {
              ...sending,
              status: 'ACCEPTED',
              acceptedAt: new Date().toISOString(),
              groupId: receipt.groupId,
              messageId: receipt.messageId,
              report: 'ACCEPTED',
            },
            token,
          );
          return;
        case 'rejected': {
          const failures = sending.failures + 1;
          await this.finish(
            {
              ...sending,
              failures,
              providerCode: receipt.code,
              status: failures >= 5 ? 'FAILED' : 'PENDING',
              reason: 'PROVIDER_CONFIRMED_FAILURE',
              report: failures >= 5 ? 'FAILED' : undefined,
            },
            token,
          );
          return;
        }
        case 'unknown':
          this.logger.error({
            message: '참여 제안 문자 공급자 접수 여부 운영 확인 필요',
            eventId: id,
          });
          await this.finish(
            {
              ...sending,
              status: 'UNKNOWN',
              reason: 'PROVIDER_ACCEPTANCE_UNKNOWN',
              report: 'UNKNOWN',
            },
            token,
          );
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

  // Saves first, then tries to report right away; the scheduler retries an unsent report.
  private async finish(
    record: PromotionOfferRecord,
    token: string,
  ): Promise<void> {
    await this.store.save(record, token);
    if (record.report) await this.report(record, token);
  }

  private async report(
    record: PromotionOfferRecord,
    token: string,
  ): Promise<PromotionOfferRecord> {
    const outcome = await this.application.report(record);
    if (outcome === 'retry') return record;
    if (outcome === 'stale')
      this.logger.error({
        message: '참여 제안 결과를 Application이 거절함, 운영 확인 필요',
        eventId: record.event.eventId,
        status: record.report,
      });
    const reported = { ...record, report: undefined };
    await this.store.save(reported, token);
    return reported;
  }

  // Post-acceptance failure is reported as FAILED and never re-sent: the response deadline is already running.
  private deliveryRecord(
    record: PromotionOfferRecord,
    result: PromotionDelivery,
  ): PromotionOfferRecord {
    const updated = {
      ...record,
      groupId: result.groupId,
      messageId: result.messageId,
      providerCode: result.code,
    };
    switch (result.kind) {
      case 'delivered':
        return { ...updated, status: 'DELIVERED', report: 'DELIVERED' };
      case 'failed':
        return {
          ...updated,
          status: 'FAILED',
          reason: 'PROVIDER_DELIVERY_FAILED',
          report: 'FAILED',
        };
      case 'pending':
        return updated;
      default: {
        const exhaustive: never = result.kind;
        return exhaustive;
      }
    }
  }
}
