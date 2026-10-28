import { Inject, Injectable } from '@nestjs/common';
import {
  ActiveExpo,
  fetchActiveExpos,
  fetchPreregisterSessionTitles,
} from '../common/expo-internal-api';
import { InternalCallError } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ExpoProjectionStore } from './expo-projection.store';

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });

/**
 * 박람회 목록·사전등록 회차 읽기. `expoProjection.enabled`가 false면 지금처럼 Expo를 동기 조회한다.
 * 켜져 있으면 Redis 프로젝션을 읽되, 이벤트를 한 번도 받지 않은 빈 프로젝션이면 목록을, 프로젝션에 없는
 * 박람회면 회차를 Expo에서 동기 조회한다.
 */
@Injectable()
export class ExpoReadProvider {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly projection: ExpoProjectionStore,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.expo || this.config.expoProjection.enabled);
  }

  /** 삭제 중이 아니고 종료일이 오늘(KST) 이후인 박람회. 시작일·id 순(Expo `GET /internal/expo`와 같다). */
  async activeExpos(now: Date = new Date()): Promise<ActiveExpo[]> {
    if (
      !this.config.expoProjection.enabled ||
      !(await this.projection.isReady())
    ) {
      return fetchActiveExpos(this.connection());
    }
    const expos = await this.projection.findActive(KST_DATE.format(now));
    return expos
      .sort(
        (a, b) =>
          a.startedDay.localeCompare(b.startedDay) ||
          (a.expoId < b.expoId ? -1 : a.expoId > b.expoId ? 1 : 0),
      )
      .map(({ expoId, title }) => ({ expoId, title }));
  }

  /** 프로젝션에 있는 박람회의 제목. 꺼져 있거나 없거나 삭제 중이면 undefined라 호출자가 목록 조회로 넘어간다. */
  async projectedTitle(expoId: string): Promise<string | undefined> {
    if (!this.config.expoProjection.enabled) return undefined;
    const expo = await this.projection.find(expoId);
    return expo && !expo.deleting ? expo.title : undefined;
  }

  async preregisterSessionTitles(expoId: string): Promise<Map<number, string>> {
    if (this.config.expoProjection.enabled) {
      const expo = await this.projection.find(expoId);
      // 삭제 중이면 Expo가 409로 거절하므로 그 응답을 그대로 따른다.
      if (expo && !expo.deleting) {
        return new Map(expo.sessions.map(({ id, title }) => [id, title]));
      }
    }
    return fetchPreregisterSessionTitles(this.connection(), expoId);
  }

  private connection() {
    if (!this.config.expo) throw new InternalCallError('expo not configured');
    return this.config.expo;
  }
}
