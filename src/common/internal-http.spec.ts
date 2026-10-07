import { InternalCallError, postInternal } from './internal-http';

describe('postInternal', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('내부 토큰 헤더와 JSON 바디로 POST하고 끝의 슬래시는 정리한다', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 201 } as Response);

    await postInternal('attention', 'http://attention/', '/internal/x', 'tok', {
      a: 1,
    });

    expect(fetchSpy).toHaveBeenCalledWith('http://attention/internal/x', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': 'tok',
      },
      body: JSON.stringify({ a: 1 }),
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('2xx가 아니면 URL과 토큰 없이 서비스 이름과 상태만 담아 던진다', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);

    const error = await postInternal(
      'user',
      'http://u',
      '/p',
      'secret-token',
      {},
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InternalCallError);
    expect((error as Error).message).toBe('user responded 503');
  });

  it('연결 실패도 원인 문자열을 숨기고 던진다', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED http://u secret-token'));

    const error = await postInternal(
      'user',
      'http://u',
      '/p',
      'secret-token',
      {},
    ).catch((e: unknown) => e);

    expect((error as Error).message).toBe('user unreachable');
  });
});
