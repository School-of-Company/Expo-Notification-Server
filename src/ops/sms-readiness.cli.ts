import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { loadConfig } from '../config/load-config';
import {
  collectReadiness,
  evaluateReadiness,
  readReleaseManifest,
} from './sms-readiness';

/**
 * 배포된 artifact 디렉터리에서 서비스와 같은 설정으로 실행한다(읽기 전용).
 *   node --env-file=<서비스 .env> dist/ops/sms-readiness.cli.js
 * 결과 JSON을 stdout에 쓰고, fail 항목이 없으면 0, 있으면 1, 설정/연결 준비 실패는 2로 끝난다.
 * 사용법과 판정 기준: docs/notification-27-deployment-check.md
 */
async function main(): Promise<number> {
  const config = await loadConfig();
  const release = readReleaseManifest(
    resolve(__dirname, '..', '..', 'release.json'),
  );
  const kafka = new Kafka({
    clientId: `${config.kafka.clientId}.readiness`,
    brokers: config.kafka.brokers,
    connectionTimeout: 5000,
    requestTimeout: 10000,
    retry: { retries: 2 },
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await admin.connect().catch(() => undefined);
    const snapshot = await collectReadiness(config, { admin, redis, release });
    const report = evaluateReadiness(snapshot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ready ? 0 : 1;
  } finally {
    await admin.disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `readiness check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
