import { Module } from '@nestjs/common';
import { ExpoNameProvider } from '../common/expo-name.provider';
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
    // ponytail: SmsModule과 인스턴스가 따로라 캐시도 따로다. 조회가 두 배일 뿐이라 공유 모듈은 만들지 않았다.
    ExpoNameProvider,
    PromotionStore,
    PromotionService,
    PromotionConsumer,
    PromotionScheduler,
    PromotionInternalGuard,
  ],
})
export class PromotionModule {}
