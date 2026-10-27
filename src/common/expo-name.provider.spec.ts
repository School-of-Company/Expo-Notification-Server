import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AppConfig } from '../config/app-config';
import type { ExpoProjectionStore } from '../expo-projection/expo-projection.store';
import { ExpoReadProvider } from '../expo-projection/expo-read.provider';
import { ExpoNameProvider } from './expo-name.provider';

const create = (config: AppConfig) =>
  new ExpoNameProvider(
    config,
    new ExpoReadProvider(config, {} as ExpoProjectionStore),
  );

const page = (content: { expoId: string; title: string }[]) =>
  Response.json({ content, hasNext: false });

describe('ExpoNameProvider', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const config = createAppConfig();
  let provider: ExpoNameProvider;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    fetchSpy.mockReset();
    provider = create(config);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => fetchSpy.mockRestore());

  it('Expo 목록에서 제목을 찾고 10분 동안 다시 조회하지 않는다', async () => {
    fetchSpy.mockResolvedValue(page([{ expoId: 'e1', title: '광주 박람회' }]));

    await expect(provider.titleOf('e1')).resolves.toBe('광주 박람회');
    await expect(provider.titleOf('e1')).resolves.toBe('광주 박람회');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://expo.test/internal/expo?page=0&size=100',
    );

    jest.advanceTimersByTime(10 * 60_000);
    await provider.titleOf('e1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('expoId가 없거나 목록에 없으면 기본 행사명을 쓴다', async () => {
    fetchSpy.mockResolvedValue(page([{ expoId: 'e1', title: '광주 박람회' }]));

    await expect(provider.titleOf(undefined)).resolves.toBe(
      config.sms.expoName,
    );
    await expect(provider.titleOf('ended')).resolves.toBe(config.sms.expoName);
  });

  it('조회가 실패하면 기본 행사명을 쓰고 실패는 캐시하지 않는다', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    fetchSpy.mockResolvedValue(page([{ expoId: 'e1', title: '광주 박람회' }]));

    // GET은 즉시 실패를 한 번 재시도하므로 재시도 대기(가짜 타이머)를 넘겨 준다.
    const failed = provider.titleOf('e1');
    await jest.advanceTimersByTimeAsync(1000);
    await expect(failed).resolves.toBe(config.sms.expoName);
    await expect(provider.titleOf('e1')).resolves.toBe('광주 박람회');
  });

  it('Expo 연결 설정이 없으면 조회하지 않는다', async () => {
    provider = create({ ...config, expo: undefined });

    await expect(provider.titleOf('e1')).resolves.toBe(config.sms.expoName);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
