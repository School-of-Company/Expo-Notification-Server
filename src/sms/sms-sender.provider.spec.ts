import { SolapiMessageService } from 'solapi';
import { SmsDeliveryError, SmsSenderProvider } from './sms-sender.provider';

const messages = [
  { to: '01011112222', from: '0623804504', text: 'a' },
  { to: '01033334444', from: '0623804504', text: 'a' },
];

describe('SmsSenderProvider', () => {
  const send = jest.fn();
  const provider = new SmsSenderProvider({
    send,
  } as unknown as SolapiMessageService);

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
});
