import { Module } from '@nestjs/common';
import { AlarmJobLockStore } from './alarm-job-lock.store';
import { AlarmReportService } from './alarm-report.service';
import { AlarmScheduler } from './alarm.scheduler';
import { DiscordProvider } from './discord.provider';
import { ExpoApplicantCountConsumer } from './expo-applicant-count.consumer';
import { ExpoStatStore } from './expo-stat.store';

@Module({
  providers: [
    DiscordProvider,
    ExpoStatStore,
    AlarmJobLockStore,
    AlarmReportService,
    AlarmScheduler,
    ExpoApplicantCountConsumer,
  ],
})
export class AlarmModule {}
