import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AppConfig } from '../config/app-config';
import { ProjectedExpo } from './expo-changed.schema';
import type { ExpoProjectionStore } from './expo-projection.store';
import { ExpoReadProvider } from './expo-read.provider';

const projected = (
  expoId: string,
  startedDay: string,
  overrides: Partial<ProjectedExpo> = {},
): ProjectedExpo => ({
  expoId,
  title: `박람회 ${expoId}`,
  startedDay,
  finishedDay: '2030-12-31',
  deleting: false,
  sessions: [{ id: 1, title: `${expoId} 1회차` }],
  ...overrides,
});

const withProjection = (enabled: boolean): AppConfig =>
  createAppConfig({
    expoProjection: { ...createAppConfig().expoProjection, enabled },
  });

describe('ExpoReadProvider', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const store = {
    isReady: jest.fn(),
    findActive: jest.fn(),
    find: jest.fn(),
  };
  const create = (config: AppConfig) =>
    new ExpoReadProvider(config, store as unknown as ExpoProjectionStore);
  const urls = () => fetchSpy.mock.calls.map(([url]) => url as string);

  beforeEach(() => {
    fetchSpy.mockReset();
    store.isReady.mockReset().mockResolvedValue(true);
    store.findActive.mockReset().mockResolvedValue([]);
    store.find.mockReset().mockResolvedValue(null);
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          (input as string).includes('/internal/expo?')
            ? { content: [{ expoId: 'sync', title: '동기' }], hasNext: false }
            : [{ id: 9, title: '동기 회차' }],
        ),
      ),
    );
  });
  afterAll(() => fetchSpy.mockRestore());

  describe('기능이 꺼져 있으면', () => {
    const provider = create(withProjection(false));

    it('지금처럼 Expo를 동기 조회하고 프로젝션은 읽지 않는다', async () => {
      await expect(provider.activeExpos()).resolves.toEqual([
        { expoId: 'sync', title: '동기' },
      ]);
      await expect(provider.preregisterSessionTitles('a')).resolves.toEqual(
        new Map([[9, '동기 회차']]),
      );

      expect(urls()).toEqual([
        'http://expo.test/internal/expo?page=0&size=100',
        'http://expo.test/internal/expo/a/preregister-sessions',
      ]);
      expect(store.isReady).not.toHaveBeenCalled();
      expect(store.find).not.toHaveBeenCalled();
    });

    it('Expo 연결이 없으면 미설정이다', () => {
      expect(
        create({ ...withProjection(false), expo: undefined }).isConfigured(),
      ).toBe(false);
    });
  });

  describe('기능이 켜져 있으면', () => {
    const provider = create(withProjection(true));

    it('진행 중 목록을 오늘(KST) 기준으로 프로젝션에서 읽고 시작일·id 순으로 정렬한다', async () => {
      store.findActive.mockResolvedValue([
        projected('b', '2030-02-01'),
        projected('c', '2030-01-01'),
        projected('a', '2030-02-01'),
      ]);

      // UTC 2030-01-01 15:00 = KST 2030-01-02 00:00
      await expect(
        provider.activeExpos(new Date('2030-01-01T15:00:00Z')),
      ).resolves.toEqual([
        { expoId: 'c', title: '박람회 c' },
        { expoId: 'a', title: '박람회 a' },
        { expoId: 'b', title: '박람회 b' },
      ]);
      expect(store.findActive).toHaveBeenCalledWith('2030-01-02');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('이벤트를 받은 적이 있으면 빈 목록도 그대로 쓴다', async () => {
      await expect(provider.activeExpos()).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('이벤트를 한 번도 받지 않았으면 목록을 Expo에서 동기 조회한다', async () => {
      store.isReady.mockResolvedValue(false);

      await expect(provider.activeExpos()).resolves.toEqual([
        { expoId: 'sync', title: '동기' },
      ]);
      expect(store.findActive).not.toHaveBeenCalled();
    });

    it('회차는 프로젝션에서 읽는다', async () => {
      store.find.mockResolvedValue(projected('a', '2030-01-01'));

      await expect(provider.preregisterSessionTitles('a')).resolves.toEqual(
        new Map([[1, 'a 1회차']]),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['프로젝션에 없는 박람회', null],
      ['삭제 중인 박람회', projected('a', '2030-01-01', { deleting: true })],
    ])('%s의 회차는 Expo에서 동기 조회한다', async (_, found) => {
      store.find.mockResolvedValue(found);

      await expect(provider.preregisterSessionTitles('a')).resolves.toEqual(
        new Map([[9, '동기 회차']]),
      );
      expect(urls()).toEqual([
        'http://expo.test/internal/expo/a/preregister-sessions',
      ]);
    });

    it('Expo 연결이 없어도 프로젝션만으로 설정된 것으로 본다', () => {
      expect(
        create({ ...withProjection(true), expo: undefined }).isConfigured(),
      ).toBe(true);
    });
  });
});
