import { ExpoFeaturePolicyProvider } from '../../src/common/expo-feature-policy.provider';
import { createAppConfig } from './app-config.fixture';

/** `enabled`만 가짜로 바꾼 정책 provider. `enabledOrUnavailable`의 오류 분류는 실제 코드를 탄다. */
export function featurePolicyWith(
  enabled: jest.Mock,
): ExpoFeaturePolicyProvider {
  const provider = new ExpoFeaturePolicyProvider(createAppConfig());
  provider.enabled = enabled as ExpoFeaturePolicyProvider['enabled'];
  return provider;
}
