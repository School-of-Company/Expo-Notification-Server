import type { KakaoOptions } from '../../src/sms/kakao-message';
import type { OutgoingSms } from '../../src/sms/sms-sender.provider';

// 문자 건과 카톡 건(`KakaoSenderProvider`)이 같은 send-many/detail로 나간다.
export type SolapiOutgoing = OutgoingSms & { kakaoOptions?: KakaoOptions };

export const isSolapiUrl = (input: Parameters<typeof fetch>[0]): boolean =>
  (typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  ).startsWith('https://api.solapi.com/');

/**
 * Answers an event send (`SmsSenderProvider.deliver`) the way Solapi's send-many/detail would,
 * driven by an SDK-shaped `send` mock so tests keep one fake for both paths.
 * A rejected `send` becomes a transport error (acceptance unknown). No real Solapi request.
 */
export async function solapiSendManyResponse(
  init: RequestInit | undefined,
  send: (
    messages: SolapiOutgoing[],
  ) => Promise<{ failedMessageList: { to: string }[] }>,
): Promise<Response> {
  if (typeof init?.body !== 'string') throw new Error('missing solapi body');
  const body = JSON.parse(init.body) as { messages: SolapiOutgoing[] };
  const messages = body.messages.map(({ to, from, text, kakaoOptions }) => ({
    to,
    from,
    text,
    ...(kakaoOptions && { kakaoOptions }),
  }));
  const { failedMessageList } = await send(messages);
  return Response.json({
    groupInfo: {
      count: {
        total: messages.length,
        registeredSuccess: messages.length - failedMessageList.length,
        registeredFailed: failedMessageList.length,
      },
    },
    failedMessageList,
  });
}
