import { ExpoProjectionModule } from '../expo-projection/expo-projection.module';
import { Module } from '@nestjs/common';
import { AlarmJobLockStore } from './alarm-job-lock.store';
import { ApplicantCountProvider } from './applicant-count.provider';
import { AlarmReportService } from './alarm-report.service';
import { AlarmScheduler } from './alarm.scheduler';
import { DiscordProvider } from './discord.provider';
import { ExpoStatStore } from './expo-stat.store';

@Module({
  imports: [ExpoProjectionModule],
  providers: [
    DiscordProvider,
    ApplicantCountProvider,
    ExpoStatStore,
    AlarmJobLockStore,
    AlarmReportService,
    AlarmScheduler,
  ],
})
export class AlarmModule {}
