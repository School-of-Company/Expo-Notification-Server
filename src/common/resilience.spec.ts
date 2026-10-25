import { getInternal, InternalCallError, postInternal } from './internal-http';
import { guardDownstream, resetDownstreamGuards } from './resilience';

const THRESHOLD = 5;
const ok = { ok: true, status: 200 } as Response;
const fail = (status: number) => ({ ok: false, status }) as Response;
const post = (service: string) =>
  postInternal(service, 'http://x', '/p', 'tok', {}).catch((e: unknown) => e);
const get = (service: string) =>
  getInternal(service, 'http://x', '/p', 'tok').catch((e: unknown) => e);

describe('하위 서비스 회로 차단기', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => resetDownstreamGuards());
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('연속 5xx가 한도를 넘으면 회로가 열려 호출 없이 InternalCallError로 실패한다', async () => {
    fetchSpy.mockResolvedValue(fail(503));
    for (let i = 0; i < THRESHOLD; i++) await post('user');
    fetchSpy.mockClear();

    const error = await post('user');

    expect(error).toBeInstanceOf(InternalCallError);
    expect((error as Error).message).toBe('user circuit open');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('서비스마다 회로가 따로다', async () => {
    fetchSpy.mockResolvedValue(fail(500));
    for (let i = 0; i < THRESHOLD; i++) await post('user');
    fetchSpy.mockResolvedValue(ok);

    expect(await post('application')).toBe(ok);
    expect(((await post('user')) as Error).message).toBe('user circuit open');
  });

  it('4xx는 회로에 반영하지 않는다', async () => {
    fetchSpy.mockResolvedValue(fail(409));
    for (let i = 0; i < THRESHOLD * 2; i++) await post('user');
    fetchSpy.mockResolvedValue(ok);

    expect(await post('user')).toBe(ok);
  });

  it('연결 실패와 타임아웃은 장애로 센다', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchSpy.mockRejectedValue(new DOMException('t', 'TimeoutError'));
    for (let i = 0; i < THRESHOLD; i++) await post('user');
    fetchSpy.mockClear();

    expect(((await post('user')) as Error).message).toBe('user circuit open');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET은 즉시 실패를 한 번 재시도한다', async () => {
    fetchSpy.mockResolvedValueOnce(fail(503)).mockResolvedValue(ok);

    expect(await get('expo')).toBe(ok);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('GET도 4xx는 재시도하지 않는다', async () => {
    fetchSpy.mockResolvedValue(fail(404));

    expect(await get('expo')).toBeInstanceOf(InternalCallError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('POST는 5xx·연결 실패여도 재시도하지 않는다', async () => {
    fetchSpy.mockResolvedValue(fail(503));
    await post('user');
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await post('application');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('GET도 타임아웃은 재시도하지 않는다', async () => {
    fetchSpy.mockRejectedValue(new DOMException('t', 'TimeoutError'));

    expect(await get('expo')).toBeInstanceOf(InternalCallError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('회로가 열려 있으면 GET도 재시도하지 않는다', async () => {
    fetchSpy.mockResolvedValue(fail(500));
    for (let i = 0; i < THRESHOLD; i++) await post('expo');
    fetchSpy.mockClear();

    expect(((await get('expo')) as Error).message).toBe('expo circuit open');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('guardDownstream은 열린 회로를 호출자가 정한 오류로 바꾼다', async () => {
    const call = jest.fn().mockRejectedValue(new InternalCallError('x', 500));
    for (let i = 0; i < THRESHOLD; i++)
      await guardDownstream('s', false, call, () => new Error('open')).catch(
        () => undefined,
      );
    call.mockClear();

    await expect(
      guardDownstream('s', false, call, () => new Error('open')),
    ).rejects.toThrow('open');
    expect(call).not.toHaveBeenCalled();
  });
});
