import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlarmJobLockStore } from './alarm-job-lock.store';
import { AlarmReportService } from './alarm-report.service';

const TIME_ZONE = 'Asia/Seoul';
const LOCK_TTL_SECONDS = 55;

@Injectable()
export class AlarmScheduler {
  constructor(
    private readonly alarmReportService: AlarmReportService,
    private readonly jobLock: AlarmJobLockStore,
  ) {}

  @Cron('0 0 * * * *', { timeZone: TIME_ZONE })
  async sendParticipantNumberReport(): Promise<void> {
    if (!(await this.jobLock.acquire('participant-report', LOCK_TTL_SECONDS))) {
      return;
    }
    await this.alarmReportService.sendParticipantNumberReport();
  }

  @Cron('30 0 0 * * *', { timeZone: TIME_ZONE })
  async saveYesterdayApplicantCount(): Promise<void> {
    if (!(await this.jobLock.acquire('yesterday-snapshot', LOCK_TTL_SECONDS))) {
      return;
    }
    await this.alarmReportService.saveYesterdayApplicantCount();
  }
}
