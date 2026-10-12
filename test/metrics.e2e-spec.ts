import { Controller, Get, InternalServerErrorException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/config/app-config';
import { APP_CONFIG } from '../src/config/app-config.constants';
import { KAFKA_CLIENT } from '../src/kafka/kafka.constants';
import { MetricsProvider } from '../src/metrics/metrics.provider';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { SOLAPI_CLIENT } from '../src/sms/sms.constants';
import { createAppConfig } from './fixtures/app-config.fixture';
import { FakeRedis } from './fixtures/fake-redis';

const buckets = [
  '0.0005',
  '0.001',
  '0.0025',
  '0.005',
  '0.01',
  '0.015',
  '0.02',
  '0.025',
  '0.03',
  '0.035',
  '0.04',
  '0.05',
  '0.06',
  '0.075',
  '0.1',
  '0.15',
  '0.25',
  '0.5',
  '1',
  '2.5',
  '5',
  '10',
  '+Inf',
];
const registrationSchema = z.object({
  instance: z.object({
    port: z.object({ $: z.number() }),
    metadata: z.record(z.string(), z.string()),
  }),
});

@Controller('metrics-probe')
class ProbeController {
  @Get(':id')
  get(): string {
    return 'ok';
  }

  @Get(':id/failure')
  fail(): never {
    throw new InternalServerErrorException();
  }
}

describe('Metrics listener and Eureka (real HTTP)', () => {
  const apps: INestApplication<Server>[] = [];
  const servers: Server[] = [];
  const registrations: unknown[] = [];
  const events: string[] = [];
  const send = jest.fn();
  let eurekaUrl: string;
  let eurekaStatus = 204;

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing TCP address');
    return address.port;
  }

  async function createApp(overrides: Partial<AppConfig> = {}) {
    const lifecycle = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn(),
      send: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(
        createAppConfig({
          metrics: { enabled: true, port: 0, host: '127.0.0.1' },
          eureka: { serviceUrl: eurekaUrl, instance: { ipAddr: '127.0.0.1' } },
          ...overrides,
        }),
      )
      .overrideProvider(KAFKA_CLIENT)
      .useValue({ producer: () => lifecycle, consumer: () => lifecycle })
      .overrideProvider(REDIS_CLIENT)
      .useValue(new FakeRedis())
      .overrideProvider(SOLAPI_CLIENT)
      .useValue({ send })
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<Server>>();
    apps.push(app);
    return app;
  }

  function metricsUrl(app: INestApplication<Server>): string {
    const address = app.get(MetricsProvider).address;
    if (!address) throw new Error('listener not bound');
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    registrations.length = 0;
    events.length = 0;
    eurekaStatus = 204;
    send.mockReset();
    const port = await listen(
      createServer((req, res) => {
        if (req.method !== 'POST') {
          events.push(req.method ?? 'unknown');
          res.writeHead(200).end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          body += chunk;
        });
        req.on('end', () => {
          const payload: unknown = JSON.parse(body);
          registrations.push(payload);
          const metadata = registrationSchema.parse(payload).instance.metadata;
          if (metadata['prometheus.scrape'] !== 'true') {
            res.writeHead(eurekaStatus).end();
            return;
          }
          request(`http://127.0.0.1:${metadata['prometheus.port']}`)
            .get(metadata['prometheus.path'])
            .then(
              (response) => {
                events.push(`scrape:${response.status}`);
                res.writeHead(eurekaStatus).end();
              },
              () => res.writeHead(500).end(),
            );
        });
      }),
    );
    eurekaUrl = `http://127.0.0.1:${port}/eureka`;
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('실제 HTTP 응답에 공통 버킷/라벨/런타임을 노출하고 등록 시 이미 scrape 가능하다', async () => {
    const app = await createApp();
    await app.listen(0, '127.0.0.1');
    const publicUrl = await app.getUrl();
    for (const id of ['user-123', 'user-456']) {
      await request(publicUrl)
        .get(`/metrics-probe/${id}?token=synthetic-token`)
        .expect(200);
      await request(publicUrl)
        .get(`/missing/${id}?phone=01000000000`)
        .expect(404);
      await request(publicUrl)
        .get(`/internal/promotion-notifications/${id}`)
        .expect(403);
    }
    await request(publicUrl).get('/metrics-probe/user-123/failure').expect(500);
    await request(publicUrl)
      .get('/sms?phoneNumber=01000000000&code=0000')
      .expect(404);
    await request(publicUrl).post('/sms').send({}).expect(400);
    await request(publicUrl).get('/').expect(200);
    await request(publicUrl).get('/metrics').expect(404);
    await request(publicUrl).get('/sms/metrics').expect(404);
    await request(publicUrl).trace('/metrics-probe/user-123').expect(404);
    const response = await request(metricsUrl(app)).get('/metrics').expect(200);
    const body: string = response.text;
    expect(response.headers['content-type']).toContain('text/plain');
    expect(body).toContain('# TYPE http_server_requests_seconds histogram');
    expect(body).toContain('uri="/metrics-probe/:id"');
    expect(body).toContain(
      'status="403",uri="/internal/promotion-notifications/:eventId"',
    );
    expect(body).toContain('status="500",uri="/metrics-probe/:id/failure"');
    expect(body).toContain('method="OTHER",status="404",uri="unmatched"');
    expect(body).toContain('status="400",uri="/sms"');
    expect(body).toContain('status="200",uri="/"');
    expect(body).not.toMatch(
      /user-123|user-456|synthetic-token|01000000000|phoneNumber|token=/,
    );
    for (const name of [
      'process_cpu_user_seconds_total',
      'process_resident_memory_bytes',
      'nodejs_heap_size_used_bytes',
      'nodejs_eventloop_lag_seconds',
    ]) {
      expect(body).toContain(name);
    }
    const probeBuckets = body
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('http_server_requests_seconds_bucket{') &&
          line.includes('status="200",uri="/metrics-probe/:id"'),
      );
    expect(probeBuckets.map((line) => /le="([^"]+)"/.exec(line)?.[1])).toEqual(
      buckets,
    );
    expect(probeBuckets.at(-1)).toMatch(/ 2$/);
    expect(body).toContain(
      'http_server_requests_seconds_count{method="GET",status="200",uri="/metrics-probe/:id"} 2',
    );
    const instance = registrationSchema.parse(registrations[0]).instance;
    expect(instance.port.$).toBe(3000);
    expect(instance.metadata).toEqual({
      'prometheus.scrape': 'true',
      'prometheus.port': String(app.get(MetricsProvider).address?.port),
      'prometheus.path': '/metrics',
    });
    expect(events).toContain('scrape:200');
    await request(metricsUrl(app)).post('/metrics').expect(404);
    await request(metricsUrl(app)).get('/anything').expect(404);
  });

  it('disabled이면 listener와 scrape metadata 없이 서비스만 등록한다', async () => {
    const app = await createApp({
      metrics: { enabled: false, port: 0, host: '127.0.0.1' },
    });
    await app.init();
    expect(app.get(MetricsProvider).address).toBeUndefined();
    expect(
      registrationSchema.parse(registrations[0]).instance.metadata,
    ).toEqual({});
    expect(events).not.toContain('scrape:200');
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });

  it('메트릭 렌더링 실패는 내부 listener에서 500으로 응답한다', async () => {
    const app = await createApp();
    await app.init();
    const spy = jest
      .spyOn(app.get(MetricsProvider).registry, 'metrics')
      .mockRejectedValue(new Error('synthetic collection failure'));
    try {
      await request(metricsUrl(app)).get('/metrics').expect(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('광고 IP와 bind가 다르면 scrape metadata를 등록하지 않는다', async () => {
    const app = await createApp({
      eureka: { serviceUrl: eurekaUrl, instance: { ipAddr: '10.0.0.9' } },
    });
    await app.init();
    expect(app.get(MetricsProvider).address).toBeDefined();
    expect(
      registrationSchema.parse(registrations[0]).instance.metadata,
    ).toEqual({});
  });

  it('bind 실패 시 부팅을 거부하고 Eureka에 등록하지 않는다', async () => {
    const port = await listen(createServer());
    const app = await createApp({
      metrics: { enabled: true, port, host: '127.0.0.1' },
    });
    await expect(app.init()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(registrations).toHaveLength(0);
    expect(app.get(MetricsProvider).address).toBeUndefined();
  });

  it('Eureka 등록 실패 시 성공했던 listener도 닫는다', async () => {
    eurekaStatus = 400;
    const app = await createApp();
    await expect(app.init()).rejects.toThrow();
    expect(events).toContain('scrape:200');
    expect(app.get(MetricsProvider).address).toBeUndefined();
  });

  it('종료 시 deregister/close하며 여러 앱에서 collector를 중복 생성하지 않는다', async () => {
    const app = await createApp();
    const other = await createApp({ eureka: undefined });
    await app.init();
    await other.init();
    const url = metricsUrl(app);
    const metric = 'nodejs_heap_size_used_bytes';
    expect(app.get(MetricsProvider).registry.getSingleMetric(metric)).toBe(
      other.get(MetricsProvider).registry.getSingleMetric(metric),
    );
    await app.close();
    expect(events).toContain('DELETE');
    expect(app.get(MetricsProvider).address).toBeUndefined();
    await expect(request(url).get('/metrics')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    await request(metricsUrl(other)).get('/metrics').expect(200);
    await app.close();
  });
});
