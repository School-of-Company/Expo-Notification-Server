import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { postInternal } from '../common/internal-http';
import {
  promotionCheckSchema,
  PromotionInvalidCheckError,
  PromotionRetryError,
} from './promotion.schema';
import type { PromotionCheck, PromotionEvent } from './promotion.schema';

@Injectable()
export class PromotionApplicationProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async check(event: PromotionEvent): Promise<PromotionCheck> {
    const connection = this.config.promotion?.application;
    if (!connection) throw new PromotionRetryError();
    const response = await postInternal(
      'application',
      connection.baseUrl,
      '/internal/program-promotions/check',
      connection.internalToken,
      event,
      2000,
    );
    const body: unknown = await response.json();
    const parsed = promotionCheckSchema.safeParse(body);
    if (!parsed.success) throw new PromotionInvalidCheckError();
    const result = parsed.data;
    if (
      result.eligible &&
      (result.eventId !== event.eventId ||
        result.applicationId !== event.applicationId ||
        result.expoId !== event.expoId ||
        result.participantId !== event.participantId ||
        result.programType !== event.programType ||
        result.programId !== event.programId)
    )
      throw new PromotionInvalidCheckError();
    return result;
  }
}
