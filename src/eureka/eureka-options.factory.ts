import { hostname, networkInterfaces } from 'node:os';
import type { EurekaModuleOptions } from '@school-of-company/nestjs-eureka';
import { AppConfig } from '../config/app-config';

export const EUREKA_APP_NAME = 'expo-notification-server';

export interface InstanceDefaults {
  hostName: string;
  ipAddr: string;
}

export function detectInstanceDefaults(): InstanceDefaults {
  const ipv4 = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal);
  return { hostName: hostname(), ipAddr: ipv4?.address ?? '127.0.0.1' };
}

export function buildEurekaOptions(
  config: AppConfig,
  defaults: InstanceDefaults = detectInstanceDefaults(),
): EurekaModuleOptions | null {
  const { eureka } = config;
  if (!eureka) {
    return null;
  }
  return {
    serviceUrl: eureka.serviceUrl,
    heartbeatIntervalSeconds: eureka.heartbeatIntervalSeconds,
    leaseDurationSeconds: eureka.leaseDurationSeconds,
    requestTimeoutMs: eureka.requestTimeoutMs,
    instance: {
      app: EUREKA_APP_NAME,
      hostName: eureka.instance.hostName ?? defaults.hostName,
      ipAddr: eureka.instance.ipAddr ?? defaults.ipAddr,
      port: config.port,
    },
  };
}
