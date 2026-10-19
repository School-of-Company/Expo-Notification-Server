import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ApplicantCountProvider } from './applicant-count.provider';
import {
  buildParticipantReport,
  reportSignature,
} from './build-participant-report';
import { DiscordProvider } from './discord.provider';
import { ExpoStatStore } from './expo-stat.store';

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });

@Injectable()
export class AlarmReportService {
  private readonly logger = new Logger(AlarmReportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: ExpoStatStore,
    private readonly applicantCounts: ApplicantCountProvider,
    private readonly discord: DiscordProvider,
  ) {}

  async sendParticipantNumberReport(now: Date = new Date()): Promise<void> {
    const webhookUrl = this.config.discord.participantNumberUrl;
    if (!webhookUrl) {
      this.logger.warn(
        'discord.participantNumberUrl 미설정 — 등록 인원 리포트 생략',
      );
      return;
    }
    if (!this.applicantCounts.isConfigured()) {
      this.logger.warn(
        'expo/application 내부 API 미설정 — 등록 인원 리포트 생략',
      );
      return;
    }

    const today = KST_DATE.format(now);
    try {
      const counts = await this.applicantCounts.findAll();
      const expoIds = counts.map((count) => count.expoId);
      const [yesterday, lastSent] = await Promise.all([
        this.store.findYesterday(expoIds),
        this.store.findLastSent(expoIds),
      ]);
      const changed = counts
        .map((count, index) => ({
          stat: { ...count, yesterdayConfirmed: yesterday[index] },
          signature: reportSignature(count),
          previous: lastSent[index],
        }))
        .filter(({ signature, previous }) => signature !== previous);
      if (changed.length === 0) {
        return;
      }
      await this.discord.sendEmbeds(
        webhookUrl,
        changed.map(({ stat }) => buildParticipantReport(stat, today)),
      );
      await this.store.saveLastSent(
        changed.map(({ stat, signature }) => ({
          expoId: stat.expoId,
          signature,
        })),
      );
    } catch (error) {
      this.logger.error(
        '등록 인원 리포트 발송 실패',
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  async saveYesterdayApplicantCount(): Promise<void> {
    if (!this.applicantCounts.isConfigured()) {
      return;
    }
    for (const count of await this.applicantCounts.findAll()) {
      await this.store.saveYesterday(count.expoId, count.confirmed);
    }
  }
}
