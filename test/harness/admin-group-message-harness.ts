import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { AdminGroupMessageModule } from '../../src/admin-group-message/admin-group-message.module';
import { GROUP_MESSAGE_SENDER } from '../../src/admin-group-message/group-message-sender.interface';
import { AppConfigModule } from '../../src/config/app-config.module';
import { APP_CONFIG } from '../../src/config/app-config.constants';
import { RedisModule } from '../../src/redis/redis.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';
import { createAppConfig } from '../fixtures/app-config.fixture';
import { FakeGroupMessageSender } from '../integration/group-runtime';

async function main(): Promise<void> {
  const port = Number(process.env.GROUP_HARNESS_PORT ?? '4100');
  const redisPort = Number(process.env.GROUP_HARNESS_REDIS_PORT ?? '6379');
  const token = process.env.GROUP_HARNESS_TOKEN ?? 'g'.repeat(32);
  const redis = new Redis({
    host: '127.0.0.1',
    port: redisPort,
    keyPrefix: `group-message-harness-${randomUUID()}:`,
  });
  const config = createAppConfig({
    adminGroupMessaging: {
      enabled: true,
      internalToken: token,
      previewTtlSeconds: 1800,
      authorizationTtlSeconds: 300,
      retentionSeconds: 2592000,
    },
  });
  const module = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      ScheduleModule.forRoot(),
      RedisModule,
      AdminGroupMessageModule,
    ],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .overrideProvider(GROUP_MESSAGE_SENDER)
    .useValue(new FakeGroupMessageSender())
    .compile();
  const app = module.createNestApplication<INestApplication<Server>>();
  await app.listen(port, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string')
    throw new Error('missing harness address');
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: address.port })}\n`,
  );
  const close = async () => {
    await app.close();
    redis.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

void main();
