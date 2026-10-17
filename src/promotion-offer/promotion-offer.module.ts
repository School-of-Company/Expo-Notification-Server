import { Module } from '@nestjs/common';
import { PromotionSolapiProvider } from '../promotion/promotion-solapi.provider';
import { PromotionOfferApplicationProvider } from './promotion-offer-application.provider';
import { PromotionOfferStore } from './promotion-offer.store';
import { PromotionOfferService } from './promotion-offer.service';
import { PromotionOfferConsumer } from './promotion-offer.consumer';
import { PromotionOfferScheduler } from './promotion-offer.scheduler';
import {
  PromotionOfferController,
  PromotionOfferInternalGuard,
} from './promotion-offer.controller';

@Module({
  controllers: [PromotionOfferController],
  providers: [
    PromotionOfferApplicationProvider,
    PromotionSolapiProvider,
    PromotionOfferStore,
    PromotionOfferService,
    PromotionOfferConsumer,
    PromotionOfferScheduler,
    PromotionOfferInternalGuard,
  ],
})
export class PromotionOfferModule {}
