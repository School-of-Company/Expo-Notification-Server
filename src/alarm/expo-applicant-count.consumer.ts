import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Consumer, Kafka } from 'kafkajs';
import { parseKafkaJson } from '../common/kafka-json';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { AlarmReportService } from './alarm-report.service';
import { expoApplicantCountSchema } from './expo-applicant-count.schema';

@Injectable()
export class ExpoApplicantCountConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExpoApplicantCountConsumer.name);
  private readonly consumer: Consumer;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly alarmReportService: AlarmReportService,
  ) {
    this.consumer = kafka.consumer({ groupId: config.kafka.alarmGroupId });
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.kafka.topics.expoApplicantCount,
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const parsed = parseKafkaJson(message, expoApplicantCountSchema);
        if (!parsed.ok) {
          this.logger.warn(`잘못된 등록 인원 이벤트 무시: ${parsed.reason}`);
          return;
        }
        await this.alarmReportService.recordApplicantCount(parsed.value);
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }
}
