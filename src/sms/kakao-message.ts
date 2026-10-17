import type { AppConfig } from '../config/app-config';

export type TemplateVariables = Record<string, string>;

export interface KakaoOptions {
  pfId: string;
  templateId: string;
  variables: TemplateVariables;
  disableSms: boolean;
}

// 템플릿 본문의 #{변수}를 값으로 바꾼 문자 본문. 카톡 대체 문자와 문자 전용 발송이 같은 값을 쓴다.
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

// templateId가 있으면 카톡을 먼저 보내고 실패하면 같은 text로 문자를 보낸다. 없으면 문자로만 보낸다.
export function kakaoOptionsFor(
  config: AppConfig,
  templateId: string | undefined,
  variables: TemplateVariables,
): KakaoOptions | undefined {
  const pfId = config.kakao?.pfId;
  if (!templateId || !pfId) {
    return undefined;
  }
  return { pfId, templateId, variables, disableSms: false };
}
