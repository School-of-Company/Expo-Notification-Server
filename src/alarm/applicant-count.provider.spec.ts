import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { InternalCallError } from '../common/internal-http';
import { ApplicantCountProvider } from './applicant-count.provider';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

describe('ApplicantCountProvider', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const provider = new ApplicantCountProvider(createAppConfig());
  const urls = () => fetchSpy.mock.calls.map(([url]) => url as string);

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('Expo 목록을 끝 페이지까지 읽고 박람회마다 User 등록 인원을 붙인다', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = input as string;
      if (url.includes('/internal/expo?page=0'))
        return Promise.resolve(
          json({ content: [{ expoId: 'a', title: 'A' }], hasNext: true }),
        );
      if (url.includes('/internal/expo?page=1'))
        return Promise.resolve(
          json({ content: [{ expoId: 'b', title: 'B' }], hasNext: false }),
        );
      const expoId = /expos\/([^/]+)\//.exec(url)![1];
      return Promise.resolve(
        json({
          expoId,
          verifiedPhoneCount: 99,
          registeredParticipantCount: expoId === 'a' ? 3 : 5,
        }),
      );
    });

    await expect(provider.findAll()).resolves.toEqual([
      { expoId: 'a', title: 'A', applicationPerson: 3 },
      { expoId: 'b', title: 'B', applicationPerson: 5 },
    ]);
    expect(urls()).toEqual([
      'http://expo.test/internal/expo?page=0&size=100',
      'http://expo.test/internal/expo?page=1&size=100',
      'http://user.test/internal/expos/a/participant-stats',
      'http://user.test/internal/expos/b/participant-stats',
    ]);
    const headers = fetchSpy.mock.calls.map(
      ([, init]) =>
        (init!.headers as Record<string, string>)['X-Internal-Token'],
    );
    expect(headers).toEqual([
      'b'.repeat(32),
      'b'.repeat(32),
      'a'.repeat(32),
      'a'.repeat(32),
    ]);
  });

  it('URL 경로에 넣을 수 없는 expoId는 User를 호출하기 전에 거부한다', async () => {
    fetchSpy.mockResolvedValue(
      json({ content: [{ expoId: '../admin', title: 'X' }], hasNext: false }),
    );

    await expect(provider.findAll()).rejects.toBeInstanceOf(InternalCallError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('User 응답의 expoId가 요청과 다르면 다른 박람회 인원으로 보고 실패한다', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        json({ content: [{ expoId: 'a', title: 'A' }], hasNext: false }),
      )
      .mockResolvedValueOnce(
        json({ expoId: 'b', registeredParticipantCount: 1 }),
      );

    await expect(provider.findAll()).rejects.toBeInstanceOf(InternalCallError);
  });

  it('hasNext가 끝나지 않으면 무한히 돌지 않고 실패한다', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(json({ content: [], hasNext: true })),
    );

    await expect(provider.findAll()).rejects.toThrow('exceeded 10 pages');
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('expo 또는 user 연결 설정이 없으면 미설정으로 본다', () => {
    expect(provider.isConfigured()).toBe(true);
    expect(
      new ApplicantCountProvider(
        createAppConfig({ expo: undefined }),
      ).isConfigured(),
    ).toBe(false);
    expect(
      new ApplicantCountProvider(
        createAppConfig({ user: undefined }),
      ).isConfigured(),
    ).toBe(false);
  });
});
