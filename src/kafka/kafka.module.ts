import { Global, Module } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { APP_CONFIG } from '../config/app-config.constants';
import { AppConfig } from '../config/app-config';
import { KAFKA_CLIENT } from './kafka.constants';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Kafka({
          clientId: config.kafka.clientId,
          brokers: config.kafka.brokers,
        }),
    },
  ],
  exports: [KAFKA_CLIENT],
})
export class KafkaModule {}
