import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { InternalCallError, postInternal } from '../common/internal-http';
import {
  promotionOfferCheckSchema,
  PromotionOfferRetryError,
} from './promotion-offer.schema';
import type {
  PromotionOfferCheck,
  PromotionOfferEvent,
  PromotionOfferRecord,
} from './promotion-offer.schema';

export type ReportOutcome = 'recorded' | 'stale' | 'rejected' | 'retry';

@Injectable()
export class PromotionOfferApplicationProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private connection() {
    const connection = this.config.promotionOffer?.application;
    if (!connection) throw new PromotionOfferRetryError();
    return connection;
  }

  async check(event: PromotionOfferEvent): Promise<PromotionOfferCheck> {
    const connection = this.connection();
    const response = await postInternal(
      'application',
      connection.baseUrl,
      '/internal/promotion-offers/check',
      connection.internalToken,
      event,
      2000,
    );
    const body: unknown = await response.json();
    const parsed = promotionOfferCheckSchema.safeParse(body);
    if (!parsed.success) throw new PromotionOfferRetryError();
    const result = parsed.data;
    if (
      result.eligible &&
      (result.eventId !== event.eventId ||
        result.offerId !== event.offerId ||
        result.expoId !== event.expoId)
    )
      throw new PromotionOfferRetryError();
    return result;
  }

  // 409 means Application already holds a different result or a newer event; retrying cannot change that.
  // 400 (e.g. clock skew on acceptedAt) and 404 (offer expired or deleted) repeat identically on every retry.
  async report(record: PromotionOfferRecord): Promise<ReportOutcome> {
    const connection = this.connection();
    try {
      await postInternal(
        'application',
        connection.baseUrl,
        `/internal/promotion-offers/${record.event.offerId}/deliveries`,
        connection.internalToken,
        {
          eventId: record.event.eventId,
          status: record.report,
          attemptId: record.attemptId,
          attemptedAt: record.attemptedAt,
          providerAcceptedAt:
            record.report === 'ACCEPTED' ? record.acceptedAt : undefined,
          reason: record.reason,
        },
        5000,
      );
      return 'recorded';
    } catch (error) {
      if (!(error instanceof InternalCallError)) return 'retry';
      if (error.message.endsWith('responded 409')) return 'stale';
      if (/responded (400|404)$/.test(error.message)) return 'rejected';
      return 'retry';
    }
  }
}
