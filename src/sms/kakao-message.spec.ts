import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { kakaoOptionsFor, renderTemplate } from './kakao-message';

describe('renderTemplate', () => {
  it('#{변수}를 값으로 바꾸고 같은 변수가 두 번 나와도 모두 바꾼다', () => {
    expect(
      renderTemplate('[#{행사명}] #{이름}님, #{행사명}에서 만나요', {
        '#{행사명}': '페스타',
        '#{이름}': '홍길동',
      }),
    ).toBe('[페스타] 홍길동님, 페스타에서 만나요');
  });

  it('값의 $ 패턴을 치환 문법으로 해석하지 않는다', () => {
    expect(renderTemplate('#{이름}', { '#{이름}': "$&$'" })).toBe("$&$'");
  });

  it('값이 빠진 변수가 있으면 에러를 던진다', () => {
    expect(() =>
      renderTemplate('#{행사명} #{번호}', { '#{행사명}': '페스타' }),
    ).toThrow('#{번호}');
  });
});

describe('kakaoOptionsFor', () => {
  const variables = { '#{번호}': '7' };

  it('templateId가 있으면 대체 문자를 끈(disableSms: true) kakaoOptions를 만든다', () => {
    const config = { ...createAppConfig(), kakao: { pfId: 'pf', auto: {} } };

    expect(kakaoOptionsFor(config, 'k4', variables)).toEqual({
      pfId: 'pf',
      templateId: 'k4',
      variables,
      disableSms: true,
    });
  });

  it('templateId나 kakao 설정이 없으면 문자로만 보내도록 undefined다', () => {
    const config = { ...createAppConfig(), kakao: { pfId: 'pf', auto: {} } };

    expect(kakaoOptionsFor(config, undefined, variables)).toBeUndefined();
    expect(kakaoOptionsFor(createAppConfig(), 'k4', variables)).toBeUndefined();
  });
});
