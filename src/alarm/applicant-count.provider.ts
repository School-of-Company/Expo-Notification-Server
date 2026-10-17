import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getInternal, InternalCallError } from '../common/internal-http';
import { expoIdSchema, fetchActiveExpos } from '../common/expo-name.provider';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const participantStats = z.object({
  expoId: expoIdSchema,
  registeredParticipantCount: z.number().int().nonnegative(),
});

export interface ExpoApplicantCount {
  expoId: string;
  title: string;
  applicationPerson: number;
}

const TIMEOUT_MS = 5_000;

@Injectable()
export class ApplicantCountProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.expo && this.config.user);
  }

  async findAll(): Promise<ExpoApplicantCount[]> {
    const expos = await fetchActiveExpos(this.connection('expo'));
    return Promise.all(
      expos.map(async ({ expoId, title }) => ({
        expoId,
        title,
        applicationPerson: await this.countRegistered(expoId),
      })),
    );
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
