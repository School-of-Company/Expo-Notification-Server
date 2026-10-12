import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { buildEurekaOptions } from './eureka-options.factory';

const defaults = { hostName: 'host-default', ipAddr: '10.0.0.9' };

describe('buildEurekaOptions', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '10.0.0.9'],
    ['::', '::1'],
  ])(
    '실제 bind %s가 광고 IP %s에 도달할 때 실제 포트를 등록한다',
    (address, ipAddr) => {
      const options = buildEurekaOptions(
        createAppConfig({
          eureka: {
            serviceUrl: 'http://eureka:8761/eureka',
            instance: { ipAddr },
          },
        }),
        defaults,
        { address, port: 49152, family: 'IPv4' },
      );
      expect(options?.instance.metadata).toEqual({
        'prometheus.scrape': 'true',
        'prometheus.port': '49152',
        'prometheus.path': '/metrics',
      });
    },
  );

  it.each([
    undefined,
    { address: '127.0.0.1', port: 49152, family: 'IPv4' },
    { address: '0.0.0.0', port: 0, family: 'IPv4' },
    { address: '0.0.0.0', port: 49152, family: 'IPv6' },
  ])(
    'bind가 없거나 광고 IP에 도달하지 못하면 metadata를 생략한다: %j',
    (bind) => {
      const options = buildEurekaOptions(
        createAppConfig({
          eureka: {
            serviceUrl: 'http://eureka:8761/eureka',
            instance: { ipAddr: '::1' },
          },
        }),
        defaults,
        bind,
      );
      expect(options?.instance.metadata).toBeUndefined();
    },
  );
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
