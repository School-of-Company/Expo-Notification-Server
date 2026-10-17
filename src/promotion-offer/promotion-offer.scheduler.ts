import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { PromotionOfferStore } from './promotion-offer.store';
import { PromotionOfferService } from './promotion-offer.service';

@Injectable()
export class PromotionOfferScheduler {
  private readonly logger = new Logger(PromotionOfferScheduler.name);
  private running = false;
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PromotionOfferStore,
    private readonly service: PromotionOfferService,
  ) {}

  @Interval(5000)
  async retry(): Promise<void> {
    if (!this.config.promotionOffer?.enabled || this.running) return;
    this.running = true;
    try {
      for (const id of await this.store.due()) {
        try {
          await this.service.process(id);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.logger.warn({
            message: '참여 제안 처리 재시도 대기',
            eventId: id,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
