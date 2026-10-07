import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { UserClientProvider } from './user-client.provider';

describe('UserClientProvider', () => {
  const config = createAppConfig();
  const provider = new UserClientProvider(config);
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('POST /internal/participants/sms-try에 내부 토큰과 함께 호출한다', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

    await provider.recordSmsTry({
      expoId: 'expo-1',
      participationType: 'STANDARD',
      phoneNumber: '01012345678',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://user.test/internal/participants/sms-try');
    expect(init.headers).toMatchObject({
      'X-Internal-Token': config.user.internalToken,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      expoId: 'expo-1',
      participationType: 'STANDARD',
      phoneNumber: '01012345678',
    });
  });

  it('User가 실패 상태를 주면 던진다', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400 } as Response);

    await expect(
      provider.recordSmsTry({
        expoId: 'e',
        participationType: 'STANDARD',
        phoneNumber: '01012345678',
      }),
    ).rejects.toThrow('user responded 400');
  });
});
