import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { buildParticipantReport } from './build-participant-report';
import { DiscordProvider } from './discord.provider';
import { ExpoApplicantCountEvent } from './expo-applicant-count.schema';
import { ExpoStatStore } from './expo-stat.store';

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });

@Injectable()
export class AlarmReportService {
  private readonly logger = new Logger(AlarmReportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: ExpoStatStore,
    private readonly discord: DiscordProvider,
  ) {}

  async recordApplicantCount(event: ExpoApplicantCountEvent): Promise<void> {
    await this.store.upsert(
      event.expoId,
      event.expoTitle,
      event.applicationPerson,
    );
  }

  async sendParticipantNumberReport(now: Date = new Date()): Promise<void> {
    const webhookUrl = this.config.discord.participantNumberUrl;
    if (!webhookUrl) {
      this.logger.warn(
        'discord.participantNumberUrl 미설정 — 등록 인원 리포트 생략',
      );
      return;
    }

    const today = KST_DATE.format(now);
    const stats = await this.store.findAll();
    if (stats.length === 0) {
      return;
    }
    try {
      await this.discord.sendEmbeds(
        webhookUrl,
        stats.map((stat) => buildParticipantReport(stat, today)),
      );
    } catch (error) {
      this.logger.error(
        '등록 인원 리포트 발송 실패',
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  async saveYesterdayApplicantCount(): Promise<void> {
    for (const stat of await this.store.findAll()) {
      await this.store.saveYesterday(stat.expoId, stat.applicationPerson);
    }
  }
}
