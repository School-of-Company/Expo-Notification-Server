import { Logger } from '@nestjs/common';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { ExpoFeaturePolicyProvider } from './expo-feature-policy.provider';
import { InternalCallError } from './internal-http';
import { resetDownstreamGuards } from './resilience';

const features = (autoNotification: unknown) => ({
  title: '박람회',
  features: [
    {
      key: 'PRE_REGISTRATION',
      configuredEnabled: true,
      effectiveEnabled: true,
    },
    {
      key: 'AUTO_NOTIFICATION',
      configuredEnabled: true,
      effectiveEnabled: autoNotification,
    },
    { key: 'BULK_MESSAGE', configuredEnabled: true, effectiveEnabled: false },
  ],
  featureRevision: 4,
});

describe('ExpoFeaturePolicyProvider', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const provider = new ExpoFeaturePolicyProvider(createAppConfig());

  beforeEach(() => {
    fetchSpy.mockReset();
    resetDownstreamGuards();
  });
  afterAll(() => fetchSpy.mockRestore());

  it('effectiveEnabled만 보고 ON/OFF를 돌려준다', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(Response.json(features(true))),
    );

    await expect(provider.enabled('expo-1', 'AUTO_NOTIFICATION')).resolves.toBe(
      true,
    );
    await expect(provider.enabled('expo-1', 'BULK_MESSAGE')).resolves.toBe(
      false,
    );
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://expo.test/internal/expo/expo-1');
    expect(init?.headers).toEqual({ 'X-Internal-Token': 'b'.repeat(32) });
  });

  it.each([
    ['features 없음(구형 Expo)', { title: '박람회' }],
    ['features가 배열 아님', { features: { AUTO_NOTIFICATION: true } }],
    [
      '키 없음',
      { features: [{ key: 'BULK_MESSAGE', effectiveEnabled: true }] },
    ],
    ['effectiveEnabled가 boolean 아님', features('true')],
  ])('%s이면 허용으로 보지 않고 던진다', async (_name, body) => {
    fetchSpy.mockResolvedValue(Response.json(body));

    await expect(
      provider.enabled('expo-1', 'AUTO_NOTIFICATION'),
    ).rejects.toBeInstanceOf(InternalCallError);
  });

  it('JSON이 아니면 던진다', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>', { status: 200 }));

    await expect(
      provider.enabled('expo-1', 'AUTO_NOTIFICATION'),
    ).rejects.toBeInstanceOf(InternalCallError);
  });

  it.each([401, 404, 503])('%i 응답이면 상태를 담아 던진다', async (status) => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(null, { status })),
    );

    await expect(
      provider.enabled('expo-1', 'AUTO_NOTIFICATION'),
    ).rejects.toMatchObject({ status });
  });

  it('URL 경로에 넣을 수 없는 expoId는 조회 없이 던진다', async () => {
    await expect(
      provider.enabled('..', 'AUTO_NOTIFICATION'),
    ).rejects.toBeInstanceOf(InternalCallError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enabledOrUnavailable은 조회 장애만 undefined로 바꾸고 다른 오류는 던진다', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    await expect(
      provider.enabledOrUnavailable('expo-1', 'AUTO_NOTIFICATION'),
    ).resolves.toBeUndefined();

    jest.spyOn(provider, 'enabled').mockRejectedValueOnce(new TypeError('bug'));
    await expect(
      provider.enabledOrUnavailable('expo-1', 'AUTO_NOTIFICATION'),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('expo 설정이 없으면 부팅은 막지 않고 WARN만 남긴다', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(() =>
      new ExpoFeaturePolicyProvider(
        createAppConfig({ expo: undefined }),
      ).onModuleInit(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    provider.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('Expo 연결 설정이 없으면 조회 없이 던진다', async () => {
    const unconfigured = new ExpoFeaturePolicyProvider(
      createAppConfig({ expo: undefined }),
    );

    await expect(
      unconfigured.enabled('expo-1', 'AUTO_NOTIFICATION'),
    ).rejects.toBeInstanceOf(InternalCallError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
