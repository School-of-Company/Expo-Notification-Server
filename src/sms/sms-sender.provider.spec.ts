import { SolapiMessageService } from 'solapi';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { SmsDeliveryError, SmsSenderProvider } from './sms-sender.provider';

const messages = [
  { to: '01011112222', from: '0623804504', text: 'a' },
  { to: '01033334444', from: '0623804504', text: 'a' },
];

describe('SmsSenderProvider', () => {
  const send = jest.fn();
  const provider = new SmsSenderProvider(
    { send } as unknown as SolapiMessageService,
    createAppConfig(),
  );

  beforeEach(() => send.mockReset());

  it('접수 실패 목록이 비어 있으면 실패 수신자 없음으로 돌려준다', async () => {
    send.mockResolvedValue({ failedMessageList: [] });

    await expect(provider.send(messages)).resolves.toEqual({
      total: 2,
      failedTo: [],
    });
    expect(send).toHaveBeenCalledWith(messages);
  });

  it('응답의 failedMessageList에서 실패 수신자를 뽑는다', async () => {
    send.mockResolvedValue({ failedMessageList: [{ to: '01033334444' }] });

    await expect(provider.send(messages)).resolves.toEqual({
      total: 2,
      failedTo: ['01033334444'],
    });
  });

  it('SDK가 MessageNotReceivedError를 던져도 실패 수신자로 변환한다', async () => {
    send.mockRejectedValue({ failedMessageList: [{ to: '01011112222' }] });

    await expect(provider.send(messages)).resolves.toEqual({
      total: 2,
      failedTo: ['01011112222'],
    });
  });

  it('그 외 에러는 원본 메시지를 숨기고 SmsDeliveryError로 던진다', async () => {
    send.mockRejectedValue(new Error('apiKey=secret-key rejected'));

    const error = await provider.send(messages).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SmsDeliveryError);
    expect((error as Error).message).not.toContain('secret-key');
  });

  describe('deliver (Kafka 이벤트, HTTP 1회)', () => {
    let fetchMock: jest.SpyInstance;
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const result = (success: number, failed: string[]) => ({
      groupInfo: {
        groupId: 'G1',
        count: {
          total: success + failed.length,
          registeredSuccess: success,
          registeredFailed: failed.length,
        },
      },
      failedMessageList: failed.map((to) => ({ to, statusCode: '3059' })),
    });
    const connectError = (code: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: { code } });

    beforeEach(() => {
      fetchMock = jest.spyOn(global, 'fetch');
    });
    afterEach(() => fetchMock.mockRestore());

    it('SDK 대신 send-many/detail을 한 번만 호출하고 eventId를 customFields로 남긴다', async () => {
      fetchMock.mockReturnValue(json(result(2, [])));

      await expect(provider.deliver('e1', messages)).resolves.toEqual({
        kind: 'accepted',
        failedTo: [],
      });
      expect(send).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.solapi.com/messages/v4/send-many/detail');
      expect(JSON.parse(init.body as string)).toEqual({
        messages: messages.map((m) => ({
          ...m,
          customFields: { eventId: 'e1' },
        })),
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('부분 실패는 접수로 보고 실패 수신자를 돌려준다', async () => {
      fetchMock.mockReturnValue(json(result(1, ['01033334444'])));

      await expect(provider.deliver('e1', messages)).resolves.toEqual({
        kind: 'accepted',
        failedTo: ['01033334444'],
      });
    });

    it.each([
      [
        '전부 접수 실패',
        () =>
          json(
            result(
              0,
              messages.map((m) => m.to),
            ),
          ),
      ],
      ['4xx 거부', () => json({ errorCode: 'NotEnoughBalance' }, 402)],
      ['연결 거부', () => Promise.reject(connectError('ECONNREFUSED'))],
      ['DNS 실패', () => Promise.reject(connectError('ENOTFOUND'))],
    ])('%s는 확실한 미접수(rejected)다', async (_, reply) => {
      fetchMock.mockImplementation(reply);

      await expect(provider.deliver('e1', messages)).resolves.toMatchObject({
        kind: 'rejected',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        '응답 timeout',
        () =>
          Promise.reject(
            new DOMException('The operation was aborted', 'TimeoutError'),
          ),
      ],
      ['연결 끊김', () => Promise.reject(connectError('ECONNRESET'))],
      ['503', () => json({}, 503)],
      ['408', () => json({}, 408)],
      ['해석 불가 본문', () => json({ ok: true })],
      ['건수 불일치', () => json(result(1, []))],
      [
        '본문 읽기 실패',
        () =>
          Promise.resolve(
            new Response('{', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
      ],
    ])('%s는 결과 불명(unknown)이고 다시 요청하지 않는다', async (_, reply) => {
      fetchMock.mockImplementation(reply);

      await expect(provider.deliver('e1', messages)).resolves.toEqual({
        kind: 'unknown',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
