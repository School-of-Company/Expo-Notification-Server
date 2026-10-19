import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OpenAPIObject } from '@nestjs/swagger';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { APP_CONFIG } from '../src/config/app-config.constants';
import { KAFKA_CLIENT } from '../src/kafka/kafka.constants';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { SOLAPI_CLIENT } from '../src/sms/sms.constants';
import { setupSwagger } from '../src/swagger';
import { createAppConfig } from './fixtures/app-config.fixture';
import { FakeRedis } from './fixtures/fake-redis';

describe.each([
  { enabled: false, includeInternal: false },
  { enabled: false, includeInternal: true },
  { enabled: true, includeInternal: false },
  { enabled: true, includeInternal: true },
])('Swagger %j (e2e)', (swagger) => {
  let app: INestApplication<App>;
  const send = jest.fn();

  beforeAll(async () => {
    const lifecycle = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn(),
      send: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(createAppConfig({ swagger }))
      .overrideProvider(KAFKA_CLIENT)
      .useValue({ producer: () => lifecycle, consumer: () => lifecycle })
      .overrideProvider(REDIS_CLIENT)
      .useValue(new FakeRedis())
      .overrideProvider(SOLAPI_CLIENT)
      .useValue({ send })
      .compile();
    app = moduleRef.createNestApplication();
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('JSON/UI 노출과 내부 경로·인증 스키마가 옵션을 따른다', async () => {
    const response = await request(app.getHttpServer())
      .get('/sms/v3/api-docs')
      .expect(swagger.enabled ? 200 : 404);
    await request(app.getHttpServer())
      .get('/sms/docs')
      .expect(swagger.enabled ? 200 : 404);
    await request(app.getHttpServer()).get('/sms/docs-yaml').expect(404);
    await request(app.getHttpServer())
      .get(
        '/internal/promotion-notifications/00000000-0000-4000-8000-000000000001',
      )
      .expect(403);
    if (!swagger.enabled) return;
    const document = response.body as OpenAPIObject;
    expect(document.openapi).toMatch(/^3\./);
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(document.security).toBeUndefined();
    expect(document.paths['/'].get?.security).toEqual([{ bearerAuth: [] }]);
    for (const operation of [
      document.paths['/sms'].post,
      document.paths['/sms'].get,
      document.paths['/sms/verify'].post,
    ]) {
      expect(operation).toBeDefined();
      expect(operation?.security).toBeUndefined();
    }
    for (const status of ['200', '400', '429', '502', '500']) {
      expect(document.paths['/sms'].post?.responses).toHaveProperty(status);
    }
    for (const status of ['200', '400', '404', '429', '500']) {
      expect(document.paths['/sms/verify'].post?.responses).toHaveProperty(
        status,
      );
    }
    expect(document.paths['/sms'].get?.deprecated).toBe(true);
    expect(document.components?.schemas?.SendCodeDto).toMatchObject({
      properties: { phoneNumber: { example: '01000000000' } },
    });
    expect(document.components?.schemas?.VerifyCodeDto).toMatchObject({
      properties: { code: { example: '0000' } },
    });
    const internal = Object.keys(document.paths).filter((path) =>
      path.startsWith('/internal/'),
    );
    expect(internal.sort()).toEqual(
      swagger.includeInternal
        ? [
            '/internal/admin-group-messages/config',
            '/internal/admin-group-messages/expos/{expoId}/history',
            '/internal/admin-group-messages/jobs/{jobId}',
            '/internal/admin-group-messages/jobs/{jobId}/retries',
            '/internal/admin-group-messages/previews',
            '/internal/admin-group-messages/previews/{previewId}/jobs',
            '/internal/promotion-notifications/ops/audit',
            '/internal/promotion-notifications/{eventId}',
            '/internal/promotion-notifications/{eventId}/reconciliation',
            '/internal/promotion-notifications/{eventId}/resumption',
            '/internal/promotion-offer-notifications/{eventId}',
            '/internal/promotion-offer-notifications/{eventId}/reconciliation',
          ]
        : [],
    );
    if (swagger.includeInternal) {
      expect(document.components?.securitySchemes?.internalToken).toEqual(
        expect.objectContaining({
          type: 'apiKey',
          in: 'header',
          name: 'X-Internal-Token',
        }),
      );
      for (const path of internal) {
        const operation = document.paths[path].get ?? document.paths[path].post;
        expect(operation?.security).toEqual([{ internalToken: [] }]);
        expect(operation?.responses).toHaveProperty(
          path.endsWith('/history') ? '401' : '403',
        );
      }
      const history =
        document.paths['/internal/admin-group-messages/expos/{expoId}/history']
          .get;
      expect(history?.responses).toHaveProperty('400');
      expect(history?.responses).toHaveProperty('503');
      expect(JSON.stringify(history?.responses['200'])).toContain(
        'applicationCount',
      );
      expect(JSON.stringify(history?.responses['200'])).toContain('delivered');
    } else {
      expect(
        document.components?.securitySchemes?.internalToken,
      ).toBeUndefined();
    }
    expect(send).not.toHaveBeenCalled();
  });
});
