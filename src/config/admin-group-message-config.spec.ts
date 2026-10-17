import { appConfigSchema } from './app-config';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';

describe('admin group message Kakao config', () => {
  it('requires the approved content placeholders to match the explicit semantic mapping', () => {
    const base = createAppConfig();
    const result = appConfigSchema.safeParse({
      ...base,
      adminGroupMessaging: {
        enabled: true,
        internalToken: 'g'.repeat(32),
        kakao: {
          enabled: true,
          pfId: 'pf-id',
          templates: [
            {
              id: 'template',
              name: '안내',
              providerTemplateId: 'provider-template',
              content: '#{이름}님의 #{프로그램} 안내',
              variableMapping: { name: '#{이름}' },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts expoName and status in the mapping (K6 프로그램 참가 안내)', () => {
    const result = appConfigSchema.safeParse({
      ...createAppConfig(),
      adminGroupMessaging: {
        enabled: true,
        internalToken: 'g'.repeat(32),
        kakao: {
          enabled: true,
          pfId: 'pf-id',
          templates: [
            {
              id: 'program-guide',
              name: '프로그램 참가 안내',
              providerTemplateId: 'provider-template',
              content:
                '[#{행사명}] 안내\n#{이름}님께 안내드립니다.\n\n신청하신 프로그램 참가 일정을 알려드립니다.\n- 프로그램: #{프로그램}\n- 일시: #{일시}\n- 신청 상태: #{상태}',
              variableMapping: {
                expoName: '#{행사명}',
                name: '#{이름}',
                programName: '#{프로그램}',
                sessionName: '#{일시}',
                status: '#{상태}',
              },
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts 900 Unicode characters and rejects 1001 in approved Kakao content', () => {
    const base = createAppConfig();
    const withContent = (content: string) => ({
      ...base,
      adminGroupMessaging: {
        enabled: true,
        internalToken: 'g'.repeat(32),
        kakao: {
          enabled: true,
          pfId: 'pf-id',
          templates: [
            {
              id: 'template',
              name: '안내',
              providerTemplateId: 'provider-template',
              content,
              variableMapping: {},
            },
          ],
        },
      },
    });
    expect(
      appConfigSchema.safeParse(withContent('가'.repeat(900))).success,
    ).toBe(true);
    expect(
      appConfigSchema.safeParse(withContent('가'.repeat(1001))).success,
    ).toBe(false);
  });

  it('rejects job retention shorter than preview retention to prevent replay', () => {
    const base = createAppConfig();
    expect(
      appConfigSchema.safeParse({
        ...base,
        adminGroupMessaging: {
          enabled: true,
          internalToken: 'g'.repeat(32),
          previewTtlSeconds: 60,
          retentionSeconds: 59,
        },
      }).success,
    ).toBe(false);
  });
});
