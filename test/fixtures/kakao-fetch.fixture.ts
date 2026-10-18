import type { OutgoingKakao } from '../../src/sms/kakao-sender.provider';

export type KakaoOutcome = 'accepted' | 'failed' | 'network-error';

/** `KakaoSenderProvider`가 쓰는 global fetch를 가로챈다. 문자 sender는 각 spec이 따로 mock한다. */
export function mockKakaoFetch(outcome: KakaoOutcome = 'accepted') {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation((_input, init?: RequestInit) => {
      if (outcome === 'network-error')
        return Promise.reject(new TypeError('synthetic network error'));
      if (typeof init?.body !== 'string')
        throw new Error('missing solapi body');
      const { messages } = JSON.parse(init.body) as {
        messages: OutgoingKakao[];
      };
      return Promise.resolve(
        Response.json({
          failedMessageList:
            outcome === 'failed'
              ? messages.map(({ to }) => ({ to, statusCode: '3040' }))
              : [],
        }),
      );
    });
}

/** fetch로 나간 카톡 요청의 메시지 목록. */
export function sentKakaoMessages(
  fetch: ReturnType<typeof mockKakaoFetch>,
): (OutgoingKakao & { customFields?: Record<string, string> })[] {
  return fetch.mock.calls.flatMap(([, init]) =>
    typeof init?.body === 'string'
      ? (
          JSON.parse(init.body) as {
            messages: (OutgoingKakao & {
              customFields?: Record<string, string>;
            })[];
          }
        ).messages
      : [],
  );
}
