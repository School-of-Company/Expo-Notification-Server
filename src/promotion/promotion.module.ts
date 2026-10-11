import { Module } from '@nestjs/common';
import { PromotionApplicationProvider } from './promotion-application.provider';
import { PromotionSolapiProvider } from './promotion-solapi.provider';
import { PromotionStore } from './promotion.store';
import { PromotionService } from './promotion.service';
import { PromotionConsumer } from './promotion.consumer';
import { PromotionScheduler } from './promotion.scheduler';
import {
  PromotionController,
  PromotionInternalGuard,
} from './promotion.controller';

@Module({
  controllers: [PromotionController],
  providers: [
    PromotionApplicationProvider,
    PromotionSolapiProvider,
    PromotionStore,
    PromotionService,
    PromotionConsumer,
    PromotionScheduler,
    PromotionInternalGuard,
  ],
})
export class PromotionModule {}
