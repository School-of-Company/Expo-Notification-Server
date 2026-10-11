import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';

export async function until(
  check: () => boolean | Promise<boolean>,
  deadline = Date.now() + 45000,
): Promise<void> {
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('integration condition timed out');
    await delay(50);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

// Only container IDs successfully created by this run may be removed.
export class LocalInfra {
  readonly namespace = `notification8-${randomUUID()}`;
  private readonly containers: string[] = [];
  kafkaPort = 0;
  redisPort = 0;

  async start(): Promise<void> {
    this.kafkaPort = await freePort();
    this.redisPort = await freePort();
    this.run('redis', [
      '-p',
      `127.0.0.1:${this.redisPort}:6379`,
      'redis:7.4-alpine',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    this.run('kafka', [
      '-p',
      `127.0.0.1:${this.kafkaPort}:9092`,
      '-e',
      'KAFKA_NODE_ID=1',
      '-e',
      'KAFKA_PROCESS_ROLES=broker,controller',
      '-e',
      'KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
      '-e',
      `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${this.kafkaPort}`,
      '-e',
      'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
      '-e',
      'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      '-e',
      'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093',
      '-e',
      'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
      '-e',
      'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
      '-e',
      'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
      '-e',
      'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
      '-e',
      'KAFKA_AUTO_CREATE_TOPICS_ENABLE=false',
      'apache/kafka:3.9.1',
    ]);
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    const deadline = Date.now() + 45000;
    const redis = new Redis({
      host: '127.0.0.1',
      port: this.redisPort,
      lazyConnect: true,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined);
    const admin = new Kafka({
      brokers: [`127.0.0.1:${this.kafkaPort}`],
      logLevel: logLevel.NOTHING,
      connectionTimeout: 1000,
      requestTimeout: 1000,
      retry: { retries: 0 },
    }).admin();
    try {
      await until(async () => {
        try {
          await redis.connect();
          return (await redis.ping()) === 'PONG';
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return false;
        }
      }, deadline);
      await until(async () => {
        try {
          await admin.connect();
          await admin.listTopics();
          return true;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return false;
        }
      }, deadline);
    } finally {
      redis.disconnect();
      await admin.disconnect();
    }
  }

  private run(service: string, args: string[]): void {
    const id = execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        `${this.namespace}-${service}`,
        '--label',
        `notification.issue8.run=${this.namespace}`,
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    this.containers.push(id);
  }

  stop(): void {
    const errors: Error[] = [];
    for (const id of [...this.containers].reverse()) {
      try {
        execFileSync('docker', ['rm', '--force', id], {
          stdio: 'pipe',
          timeout: 5000,
        });
        this.containers.splice(this.containers.indexOf(id), 1);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error('container removal failed'),
        );
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'owned container cleanup failed');
  }
}
