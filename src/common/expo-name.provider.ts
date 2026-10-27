import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ExpoReadProvider } from '../expo-projection/expo-read.provider';

const CACHE_TTL_MS = 10 * 60_000;

/** 문자·알림톡의 #{행사명}. 못 찾으면 sms.expoName을 돌려주고 발송을 막지 않는다. */
@Injectable()
export class ExpoNameProvider {
  private readonly logger = new Logger(ExpoNameProvider.name);
  // ponytail: 목록 전체를 10분 캐시한다. 그 사이 새로 만든 박람회는 기본 행사명으로 나간다. 박람회가 수백 개가 되면 Expo에 단건 조회 API를 추가한다.
  private cache?: { at: number; titles: Promise<Map<string, string>> };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly expos: ExpoReadProvider,
  ) {}

  async titleOf(expoId: string | undefined): Promise<string> {
    const fallback = this.config.sms.expoName;
    if (!expoId || !this.expos.isConfigured()) return fallback;
    if (!this.cache || Date.now() - this.cache.at >= CACHE_TTL_MS) {
      const titles = this.expos
        .activeExpos()
        .then(
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
