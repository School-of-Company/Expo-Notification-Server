import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getInternal, InternalCallError } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const expoId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
const expoPage = z.object({
  content: z.array(z.object({ expoId, title: z.string().min(1) })),
  hasNext: z.boolean(),
});
const participantStats = z.object({
  expoId,
  registeredParticipantCount: z.number().int().nonnegative(),
});

export interface ExpoApplicantCount {
  expoId: string;
  title: string;
  applicationPerson: number;
}

const PAGE_SIZE = 100;
// ponytail: 진행 중·예정 박람회가 1,000개를 넘으면 리포트가 실패한다. 그때 상한을 올린다.
const MAX_PAGES = 10;
const TIMEOUT_MS = 5_000;

@Injectable()
export class ApplicantCountProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.expo && this.config.user);
  }

  async findAll(): Promise<ExpoApplicantCount[]> {
    const expos = await this.findActiveExpos();
    return Promise.all(
      expos.map(async ({ expoId, title }) => ({
        expoId,
        title,
        applicationPerson: await this.countRegistered(expoId),
      })),
    );
  }

  private async findActiveExpos(): Promise<
    { expoId: string; title: string }[]
  > {
    const { baseUrl, internalToken } = this.connection('expo');
    const expos: { expoId: string; title: string }[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await getInternal(
        'expo',
        baseUrl,
        `/internal/expo?page=${page}&size=${PAGE_SIZE}`,
        internalToken,
        TIMEOUT_MS,
      );
      const parsed = expoPage.safeParse(await response.json());
      if (!parsed.success) {
        throw new InternalCallError('expo returned an invalid expo list');
      }
      expos.push(...parsed.data.content);
      if (!parsed.data.hasNext) return expos;
    }
    throw new InternalCallError(`expo list exceeded ${MAX_PAGES} pages`);
  }

  private async countRegistered(id: string): Promise<number> {
    const { baseUrl, internalToken } = this.connection('user');
    const response = await getInternal(
      'user',
      baseUrl,
      `/internal/expos/${encodeURIComponent(id)}/participant-stats`,
      internalToken,
      TIMEOUT_MS,
    );
    const parsed = participantStats.safeParse(await response.json());
    if (!parsed.success || parsed.data.expoId !== id) {
      throw new InternalCallError('user returned invalid participant stats');
    }
    return parsed.data.registeredParticipantCount;
  }

  private connection(service: 'expo' | 'user') {
    const connection = this.config[service];
    if (!connection) throw new InternalCallError(`${service} not configured`);
    return connection;
  }
}
