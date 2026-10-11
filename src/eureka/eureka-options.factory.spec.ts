import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { buildEurekaOptions } from './eureka-options.factory';

const defaults = { hostName: 'host-default', ipAddr: '10.0.0.9' };

describe('buildEurekaOptions', () => {
  it('eureka 설정이 없으면 null (등록하지 않는다)', () => {
    expect(buildEurekaOptions(createAppConfig(), defaults)).toBeNull();
  });

  it('앱 이름은 expo-notification-server, 포트는 서비스 포트를 쓴다', () => {
    const options = buildEurekaOptions(
      createAppConfig({
        port: 4000,
        eureka: { serviceUrl: 'http://eureka:8761/eureka', instance: {} },
      }),
      defaults,
    );

    expect(options).toMatchObject({
      serviceUrl: 'http://eureka:8761/eureka',
      instance: {
        app: 'expo-notification-server',
        hostName: 'host-default',
        ipAddr: '10.0.0.9',
        port: 4000,
      },
    });
  });

  it('설정의 호스트명/IP가 감지한 기본값보다 우선한다', () => {
    const options = buildEurekaOptions(
      createAppConfig({
        eureka: {
          serviceUrl: 'http://eureka:8761/eureka',
          heartbeatIntervalSeconds: 10,
          instance: { hostName: 'notification-1', ipAddr: '10.1.1.1' },
        },
      }),
      defaults,
    );

    expect(options?.heartbeatIntervalSeconds).toBe(10);
    expect(options?.instance).toMatchObject({
      hostName: 'notification-1',
      ipAddr: '10.1.1.1',
    });
  });
});
