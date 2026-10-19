import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getInternal, InternalCallError } from '../common/internal-http';
import { expoIdSchema, fetchActiveExpos } from '../common/expo-name.provider';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const preregisterSummary = z.object({
  expoId: expoIdSchema,
  confirmedUniqueParticipants: z.number().int().nonnegative(),
  waitingParticipants: z.number().int().nonnegative(),
  sessions: z.array(
    z.object({
      sessionId: z.number().int(),
      confirmedParticipants: z.number().int().nonnegative(),
    }),
  ),
});
const preregisterSessions = z.array(
  z.object({ id: z.number().int(), title: z.string().min(1) }),
);

export interface SessionApplicantCount {
  title: string;
  confirmed: number;
}

export interface ExpoApplicantCount {
  expoId: string;
  title: string;
  /** 행사 전체 고유 확정 인원. 여러 회차에 신청한 사람도 한 명이라 회차별 합과 다를 수 있다. */
  confirmed: number;
  waiting: number;
  sessions: SessionApplicantCount[];
}

const TIMEOUT_MS = 5_000;

@Injectable()
export class ApplicantCountProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.expo && this.application());
  }

  async findAll(): Promise<ExpoApplicantCount[]> {
    const expos = await fetchActiveExpos(this.expo());
    return Promise.all(
      expos.map(async ({ expoId, title }) => {
        const [summary, sessionTitles] = await Promise.all([
          this.summary(expoId),
          this.sessionTitles(expoId),
        ]);
        return {
          expoId,
          title,
          confirmed: summary.confirmedUniqueParticipants,
          waiting: summary.waitingParticipants,
          sessions: summary.sessions.map((session) => ({
            title:
              sessionTitles.get(session.sessionId) ??
              `회차 ${session.sessionId}`,
            confirmed: session.confirmedParticipants,
          })),
        };
      }),
    );
  }

  private async summary(id: string) {
    const connection = this.application();
    if (!connection) throw new InternalCallError('application not configured');
    const { baseUrl, internalToken } = connection;
    const response = await getInternal(
      'application',
      baseUrl,
      `/internal/expos/${encodeURIComponent(id)}/preregistrations/summary`,
      internalToken,
      TIMEOUT_MS,
    );
    const parsed = preregisterSummary.safeParse(await response.json());
    if (!parsed.success || parsed.data.expoId !== id) {
      throw new InternalCallError(
        'application returned an invalid preregistration summary',
      );
    }
    return parsed.data;
  }

  private async sessionTitles(id: string): Promise<Map<number, string>> {
    const { baseUrl, internalToken } = this.expo();
    const response = await getInternal(
      'expo',
      baseUrl,
      `/internal/expo/${encodeURIComponent(id)}/preregister-sessions`,
      internalToken,
      TIMEOUT_MS,
    );
    const parsed = preregisterSessions.safeParse(await response.json());
    if (!parsed.success) {
      throw new InternalCallError('expo returned invalid preregister sessions');
    }
    return new Map(parsed.data.map((session) => [session.id, session.title]));
  }

  // 리포트 전용 키를 두지 않고 기존 Application 연결을 재사용한다(#68).
  private application() {
    return (
      this.config.promotionOffer?.application ??
      this.config.promotion?.application
    );
  }

  private expo() {
    if (!this.config.expo) throw new InternalCallError('expo not configured');
    return this.config.expo;
  }
}
