import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AlarmModule } from './alarm/alarm.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/app-config.module';
import { EurekaClientModule } from './eureka/eureka-client.module';
import { KafkaModule } from './kafka/kafka.module';
import { RedisModule } from './redis/redis.module';
import { SmsModule } from './sms/sms.module';
import { PromotionModule } from './promotion/promotion.module';
import { PromotionOfferModule } from './promotion-offer/promotion-offer.module';
import { AdminGroupMessageModule } from './admin-group-message/admin-group-message.module';

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    EurekaClientModule,
    KafkaModule,
    RedisModule,
    SmsModule,
    PromotionModule,
    PromotionOfferModule,
    AdminGroupMessageModule,
    AlarmModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
