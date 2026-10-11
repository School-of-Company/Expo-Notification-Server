import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { ParticipantNamesProvider } from './participant-names.provider';
import { Logger } from '@nestjs/common';

describe('ParticipantNamesProvider', () => {
  const config = createAppConfig();
  const provider = new ParticipantNamesProvider(config);
  const request = { expoId: 'expo-1', participantIds: [42, 43] };
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  afterEach(() => jest.clearAllMocks());
  afterAll(() => jest.restoreAllMocks());

  it('요청 순서대로 이름을 받아 토큰 헤더로 조회한다', async () => {
    fetchSpy.mockResolvedValue(
      Response.json([
        { participantId: 42, name: '홍길동' },
        { participantId: 43, name: '김철수' },
      ]),
    );
    const names = await provider.findNames(request);
    expect([...names]).toEqual([
      [42, '홍길동'],
      [43, '김철수'],
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://user.test/internal/standard-participants/names',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'a'.repeat(32),
        },
        body: JSON.stringify(request),
      }),
    );
  });

  it.each([404, 401, 503])(
    'HTTP %s는 빈 이름 목록으로 대체한다',
    async (status) => {
      fetchSpy.mockResolvedValue(new Response('private body', { status }));
      expect(await provider.findNames(request)).toEqual(new Map());
    },
  );

  it.each([
    null,
    { names: [] },
    [],
    [{ participantId: 42, name: '홍길동' }],
    [
      { participantId: 42, name: '홍길동' },
      { participantId: 42, name: '김철수' },
    ],
    [
      { participantId: 43, name: '김철수' },
      { participantId: 42, name: '홍길동' },
    ],
    [
      { participantId: 42, name: null },
      { participantId: 43, name: '김철수' },
    ],
    [
      { participantId: 42, name: '가'.repeat(11) },
      { participantId: 43, name: '김철수' },
    ],
    [
      { participantId: 42, name: '홍\n길동' },
      { participantId: 43, name: '김철수' },
    ],
  ])('잘못된 응답은 일부 이름도 쓰지 않는다: %j', async (body) => {
    fetchSpy.mockResolvedValue(Response.json(body));
    expect(await provider.findNames(request)).toEqual(new Map());
  });

  it('JSON 파싱 실패는 응답 내용 노출 없이 fallback한다', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(new Response('private name/code/url'));
    expect(await provider.findNames(request)).toEqual(new Map());
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/private|code|url/);
  });

  it('공통 10초 대신 이름 조회에 2초 timeout을 설정한다', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    fetchSpy.mockRejectedValue(new Error('private phone/link'));
    expect(await provider.findNames(request)).toEqual(new Map());
    expect(timeout).toHaveBeenCalledWith(2000);
    timeout.mockRestore();
  });

  it('User 설정 누락은 HTTP 호출 없이 역할 라벨로 대체한다', async () => {
    const withoutUser = new ParticipantNamesProvider({
      ...config,
      user: undefined,
    });
    expect(await withoutUser.findNames(request)).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
