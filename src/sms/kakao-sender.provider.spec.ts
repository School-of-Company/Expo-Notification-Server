import { Logger } from '@nestjs/common';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import {
  mockKakaoFetch,
  sentKakaoMessages,
} from '../../test/fixtures/kakao-fetch.fixture';
import { KakaoSenderProvider } from './kakao-sender.provider';

describe('KakaoSenderProvider', () => {
  const message = {
    to: '01012345678',
    from: '0623804504',
    text: '인증번호 1234',
    kakaoOptions: {
      pfId: 'pf-1',
      templateId: 'k1',
      variables: { '#{인증번호}': '1234' },
      disableSms: true as const,
    },
  };
  let warn: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('대체 문자를 끈 카톡을 customFields와 함께 한 번 보낸다', async () => {
    const fetch = mockKakaoFetch();

    await new KakaoSenderProvider(createAppConfig()).send([message], {
      eventId: 'e1',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentKakaoMessages(fetch)).toEqual([
      { ...message, customFields: { eventId: 'e1' } },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['failed', 'network-error'] as const)(
    '실패(%s)해도 던지지 않고 마스킹한 번호만 경고로 남긴다',
    async (outcome) => {
      mockKakaoFetch(outcome);

      await expect(
        new KakaoSenderProvider(createAppConfig()).send([message]),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain('010****5678');
      expect(logged).not.toContain('01012345678');
      expect(logged).not.toContain('1234');
      expect(logged).not.toContain(message.text);
    },
  );

  it('비정상 응답도 결과 불명으로 경고만 남긴다', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('oops', { status: 500 }));

    await expect(
      new KakaoSenderProvider(createAppConfig()).send([message]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
