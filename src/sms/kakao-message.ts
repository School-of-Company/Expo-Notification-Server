import type { AppConfig } from '../config/app-config';

export type TemplateVariables = Record<string, string>;

export interface KakaoOptions {
  pfId: string;
  templateId: string;
  variables: TemplateVariables;
  // 문자는 같은 text로 따로 보내므로 Solapi 대체 문자는 항상 끈다.
  disableSms: true;
}

// 템플릿 본문의 #{변수}를 값으로 바꾼 문자 본문. 카톡과 함께 나가는 문자와 문자 전용 발송이 같은 값을 쓴다.
export function renderTemplate(
  content: string,
  variables: TemplateVariables,
): string {
  return content.replace(/#\{[^{}]+\}/g, (placeholder) => {
    const value = variables[placeholder];
    if (value === undefined) {
      throw new Error(`missing template variable ${placeholder}`);
    }
    return value;
  });
}

// templateId가 있으면 문자와 별도로 같은 text의 카톡을 한 건 더 보낸다(비용 2배는 의도). 없으면 문자로만 보낸다.
export function kakaoOptionsFor(
  config: AppConfig,
  templateId: string | undefined,
  variables: TemplateVariables,
): KakaoOptions | undefined {
  const pfId = config.kakao?.pfId;
  if (!templateId || !pfId) {
    return undefined;
  }
  return { pfId, templateId, variables, disableSms: true };
}
