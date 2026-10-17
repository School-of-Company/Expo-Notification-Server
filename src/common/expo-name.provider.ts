import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { getInternal, InternalCallError } from './internal-http';

export const expoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
const expoPage = z.object({
  content: z.array(
    z.object({ expoId: expoIdSchema, title: z.string().min(1) }),
  ),
  hasNext: z.boolean(),
});

export interface ActiveExpo {
  expoId: string;
  title: string;
}

const PAGE_SIZE = 100;
// ponytail: 진행 중·예정 박람회가 1,000개를 넘으면 목록 조회가 실패한다. 그때 상한을 올린다.
const MAX_PAGES = 10;
const TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;

/** Expo의 진행 중·예정 박람회 목록 전체 (`GET /internal/expo`). */
export async function fetchActiveExpos(connection: {
  baseUrl: string;
  internalToken: string;
}): Promise<ActiveExpo[]> {
  const expos: ActiveExpo[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await getInternal(
      'expo',
      connection.baseUrl,
      `/internal/expo?page=${page}&size=${PAGE_SIZE}`,
      connection.internalToken,
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

/** 문자·알림톡의 #{행사명}. 못 찾으면 sms.expoName을 돌려주고 발송을 막지 않는다. */
@Injectable()
export class ExpoNameProvider {
  private readonly logger = new Logger(ExpoNameProvider.name);
  // ponytail: 목록 전체를 10분 캐시한다. 그 사이 새로 만든 박람회는 기본 행사명으로 나간다. 박람회가 수백 개가 되면 Expo에 단건 조회 API를 추가한다.
  private cache?: { at: number; titles: Promise<Map<string, string>> };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async titleOf(expoId: string | undefined): Promise<string> {
    const fallback = this.config.sms.expoName;
    const connection = this.config.expo;
    if (!expoId || !connection) return fallback;
    if (!this.cache || Date.now() - this.cache.at >= CACHE_TTL_MS) {
      const titles = fetchActiveExpos(connection).then(
        (expos) => new Map(expos.map(({ expoId: id, title }) => [id, title])),
      );
      const entry = { at: Date.now(), titles };
      this.cache = entry;
      // 실패는 캐시하지 않는다. 다음 발송이 다시 조회한다.
      titles.catch(() => {
        if (this.cache === entry) this.cache = undefined;
      });
    }
    try {
      return (await this.cache.titles).get(expoId) ?? fallback;
    } catch (error) {
      this.logger.warn(
        `박람회 제목 조회 실패로 기본 행사명 사용: expoId=${expoId}`,
        error instanceof Error ? error.message : undefined,
      );
      return fallback;
    }
  }
}
