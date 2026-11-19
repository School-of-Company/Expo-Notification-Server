import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ExpoFeatureKey, fetchExpoFeatureEnabled } from './expo-internal-api';
import { InternalCallError } from './internal-http';

/**
 * 발송 직전 박람회 기능 확인. 프로젝션·캐시를 쓰지 않고 매번 Expo를 동기 조회한다(지연된 값으로 OFF 발송을 허용하지 않는다).
 * 조회 실패·구형 응답은 `InternalCallError`로 던진다. 기본 ON/OFF로 대체하지 않는다. 404면 `status`가 404다.
 */
@Injectable()
export class ExpoFeaturePolicyProvider implements OnModuleInit {
  private readonly logger = new Logger(ExpoFeaturePolicyProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  // `expo`는 설정상 선택이라(배포 환경 설정이 저장소 밖에 있다) 부팅을 막지 않는다. 대신 모든 자동 알림·단체 발송이
  // 정책 조회 장애(503·재시도)가 된다는 것을 부팅 시점에 드러낸다.
  onModuleInit(): void {
    if (!this.config.expo)
      this.logger.warn(
        'expo 설정이 없어 기능 정책을 조회할 수 없다: 자동 알림·단체 발송은 조회 장애(503·재시도)로 처리된다',
      );
  }

  async enabled(expoId: string, key: ExpoFeatureKey): Promise<boolean> {
    if (!this.config.expo) throw new InternalCallError('expo not configured');
    return fetchExpoFeatureEnabled(this.config.expo, expoId, key);
  }

  /** 조회 장애(`InternalCallError`)면 undefined. 그 밖의 오류(코드 버그)는 그대로 던진다. */
  async enabledOrUnavailable(
    expoId: string,
    key: ExpoFeatureKey,
  ): Promise<boolean | undefined> {
    try {
      return await this.enabled(expoId, key);
    } catch (error) {
      if (error instanceof InternalCallError) return undefined;
      throw error;
    }
  }
}
