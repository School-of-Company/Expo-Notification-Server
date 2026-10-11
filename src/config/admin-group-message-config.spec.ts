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
