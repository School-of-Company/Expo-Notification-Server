import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AttentionClientProvider } from './attention-client.provider';

describe('AttentionClientProvider', () => {
  const config = createAppConfig();
  const provider = new AttentionClientProvider(config);
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  const respond = (body: unknown, status = 201) =>
    ({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    }) as Response;

  it('POST /internal/qr-images에 내부 토큰과 참가자 정보를 보내고 URL을 돌려준다', async () => {
    fetchSpy.mockResolvedValue(respond({ url: 'https://s3.example/qr.jpg' }));

    await expect(
      provider.createQrImage({
        participationType: 'STANDARD',
        id: 42,
        phoneNumber: '01012345678',
      }),
    ).resolves.toBe('https://s3.example/qr.jpg');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://attention.test/internal/qr-images');
    expect(init.headers).toMatchObject({
      'X-Internal-Token': config.attention.internalToken,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      participationType: 'STANDARD',
      id: 42,
      phoneNumber: '01012345678',
    });
  });

  it('응답 바디에 url이 없으면 던진다', async () => {
    fetchSpy.mockResolvedValue(respond({ nope: true }));

    await expect(
      provider.createQrImage({
        participationType: 'TRAINEE',
        id: 1,
        phoneNumber: '01012345678',
      }),
    ).rejects.toThrow('invalid qr image body');
  });

  it('Attention이 실패 상태를 주면 던진다', async () => {
    fetchSpy.mockResolvedValue(respond({}, 503));

    await expect(
      provider.createQrImage({
        participationType: 'STANDARD',
        id: 1,
        phoneNumber: '01012345678',
      }),
    ).rejects.toThrow('attention responded 503');
  });
});
