import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import { AdminGroupMessageModule } from '../../src/admin-group-message/admin-group-message.module';
import { AdminGroupMessageScheduler } from '../../src/admin-group-message/admin-group-message.scheduler';
import { AdminGroupMessageStore } from '../../src/admin-group-message/admin-group-message.store';
import {
  GROUP_MESSAGE_SENDER,
  type GroupMessageDelivery,
  type GroupMessageReceipt,
  type GroupMessageSender,
  type GroupMessageTargetRecord,
} from '../../src/admin-group-message/group-message-sender.interface';
import type { GroupMessageJob } from '../../src/admin-group-message/admin-group-message.schema';
import { AppConfigModule } from '../../src/config/app-config.module';
import { APP_CONFIG } from '../../src/config/app-config.constants';
import { RedisModule } from '../../src/redis/redis.module';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';
import { createAppConfig } from '../fixtures/app-config.fixture';
import type { LocalInfra } from './local-infra';

export class FakeGroupMessageSender implements GroupMessageSender {
  readonly sends: Array<{
    jobId: string;
    targetId: string;
    phone?: string;
    content?: string;
  }> = [];
  sendResult: GroupMessageReceipt = {
    kind: 'accepted',
    groupId: 'synthetic-group',
    messageId: 'synthetic-message',
  };
  deliveryResult: GroupMessageDelivery | null = {
    kind: 'delivered',
    code: '4000',
  };

  send(
    job: GroupMessageJob,
    target: GroupMessageTargetRecord,
  ): Promise<GroupMessageReceipt> {
    this.sends.push({
      jobId: job.jobId,
      targetId: target.targetId,
      phone: target.recipientPhone,
      content: target.content,
    });
    if (target.content?.includes('__FAKE_CONFIRMED_FAILURE__'))
      return Promise.resolve({ kind: 'rejected', code: '3001' });
    if (target.content?.includes('__FAKE_UNKNOWN__'))
      return Promise.resolve({ kind: 'unknown' });
    const result = this.sendResult;
    if (result.kind !== 'accepted') return Promise.resolve(result);
    return Promise.resolve({
      ...result,
      messageId: `${result.messageId}-${target.targetId}-${this.sends.length}`,
    });
  }

  delivery(): Promise<GroupMessageDelivery | null> {
    return Promise.resolve(this.deliveryResult);
  }
}

export class GroupMessageRuntime {
  readonly redis: Redis;
  readonly sender = new FakeGroupMessageSender();
  app?: INestApplication<Server>;

  constructor(infra: Pick<LocalInfra, 'redisPort'>) {
    this.redis = new Redis({
      host: '127.0.0.1',
      port: infra.redisPort,
      lazyConnect: true,
      keyPrefix: `group-message-${Date.now()}-${Math.random()}:`,
    });
  }

  async start(port?: number): Promise<void> {
    await this.redis.connect();
    const base = createAppConfig();
    const config = createAppConfig({
      adminGroupMessaging: {
        enabled: true,
        internalToken: 'g'.repeat(32),
        previewTtlSeconds: 1800,
        authorizationTtlSeconds: 300,
        retentionSeconds: 2592000,
      },
      sms: { ...base.sms },
    });
    const module = await Test.createTestingModule({
      imports: [AppConfigModule, RedisModule, AdminGroupMessageModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(REDIS_CLIENT)
      .useValue(this.redis)
      .overrideProvider(GROUP_MESSAGE_SENDER)
      .useValue(this.sender)
      .compile();
    this.app = module.createNestApplication<INestApplication<Server>>();
    if (port === undefined) await this.app.init();
    else await this.app.listen(port, '127.0.0.1');
  }

  async dispatch(jobId?: string): Promise<void> {
    if (!this.app) throw new Error('runtime not started');
    if (jobId)
      await this.redis.zadd(
        'admin-group-message:{jobs}:due',
        Date.now() - 1,
        jobId,
      );
    await this.app.get(AdminGroupMessageScheduler).dispatch();
  }

  get store(): AdminGroupMessageStore {
    if (!this.app) throw new Error('runtime not started');
    return this.app.get(AdminGroupMessageStore);
  }

  async close(): Promise<void> {
    try {
      await this.app?.close();
    } finally {
      this.redis.disconnect();
    }
  }
}
