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

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    EurekaClientModule,
    KafkaModule,
    RedisModule,
    SmsModule,
    AlarmModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
