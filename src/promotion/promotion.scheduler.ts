import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { PromotionStore } from './promotion.store';
import { PromotionService } from './promotion.service';

@Injectable()
export class PromotionScheduler {
  private readonly logger = new Logger(PromotionScheduler.name);
  private running = false;
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PromotionStore,
    private readonly service: PromotionService,
  ) {}

  @Interval(5000)
  async retry(): Promise<void> {
    // 복구 보류 중에는 due backlog를 돌지 않는다. ACCEPTED 결과 조회는 운영 대조 API로 한다.
    if (
      !this.config.promotion?.enabled ||
      this.config.promotion.recoveryHold ||
      this.running
    )
      return;
    this.running = true;
    try {
      for (const id of await this.store.due()) {
        try {
          await this.service.process(id);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.logger.warn({
            message: '승급 안내 처리 재시도 대기',
            eventId: id,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
