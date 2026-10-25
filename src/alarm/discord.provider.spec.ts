import {
  DiscordDeliveryError,
  DiscordEmbed,
  DiscordProvider,
} from './discord.provider';
import { resetDownstreamGuards } from '../common/resilience';

const embed = (n = 1): DiscordEmbed => ({
  description: `d${n}`,
  color: 1,
  fields: [{ name: 'n', value: 'v' }],
});

describe('DiscordProvider', () => {
  const provider = new DiscordProvider();
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => resetDownstreamGuards());
  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it('웹훅 URL로 임베드를 JSON으로 POST한다 (타임아웃 시그널 포함)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

    await provider.sendEmbeds('https://discord.test/hook', [embed()]);

    expect(fetchSpy).toHaveBeenCalledWith('https://discord.test/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '', embeds: [embed()] }),
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it('임베드가 10개를 넘으면 10개씩 나눠 보낸다 (웹훅 rate limit 완화)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

    await provider.sendEmbeds(
      'https://discord.test/hook',
      Array.from({ length: 23 }, (_, i) => embed(i)),
    );

    const sizes = fetchSpy.mock.calls.map(
      ([, init]) =>
        (
          JSON.parse((init as RequestInit).body as string) as {
            embeds: unknown[];
          }
        ).embeds.length,
    );
    expect(sizes).toEqual([10, 10, 3]);
  });

  it('2xx가 아니면 URL을 노출하지 않고 DiscordDeliveryError', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 429 } as Response);

    const error = await provider
      .sendEmbeds('https://discord.test/secret-token', [embed()])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DiscordDeliveryError);
    expect((error as Error).message).toBe('discord webhook responded 429');
  });

  it('네트워크 오류도 URL 없는 DiscordDeliveryError로 감싼다', async () => {
    fetchSpy.mockRejectedValue(
      new Error('ECONNRESET https://discord.test/secret-token'),
    );

    const error = await provider
      .sendEmbeds('https://discord.test/secret-token', [embed()])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DiscordDeliveryError);
    expect((error as Error).message).not.toContain('secret-token');
  });

  describe('회로 차단기', () => {
    const send = () =>
      provider
        .sendEmbeds('https://discord.test/secret-token', [embed()])
        .catch((e: unknown) => e);

    it('5xx 실패율이 한도를 넘으면 호출 없이 DiscordDeliveryError로 실패한다', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 502 } as Response);
      for (let i = 0; i < 10; i++) await send();
      fetchSpy.mockClear();

      const error = await send();

      expect(error).toBeInstanceOf(DiscordDeliveryError);
      expect((error as Error).message).toBe('discord circuit open');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('429 같은 4xx는 회로에 반영하지 않는다', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 429 } as Response);
      for (let i = 0; i < 10; i++) await send();
      fetchSpy.mockResolvedValue({ ok: true, status: 204 } as Response);

      expect(await send()).toBeUndefined();
    });

    it('5xx·타임아웃이어도 POST는 재시도하지 않는다', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);
      await send();
      fetchSpy.mockRejectedValue(new DOMException('t', 'TimeoutError'));
      await send();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
