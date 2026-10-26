import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Module,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { HttpAccessLogMiddleware } from './http-access-log.middleware';
import { HttpAccessLogModule } from './http-access-log.module';
import { createPino, JsonLogger } from './json-logger';

type Line = Record<string, unknown>;

function captureLogs(): Line[] {
  const lines: Line[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Line);
      callback();
    },
  });
  Logger.overrideLogger(
    new JsonLogger(createPino({ service: 'expo-test', level: 'info' }, stream)),
  );
  return lines;
}

function configWith(enabled: boolean): AppConfig {
  return { httpAccessLog: { enabled } } as AppConfig;
}

@Controller()
class HealthController {
  @Get()
  health(): string {
    return 'ok';
  }
}

@Controller('probe')
class ProbeController {
  @Get(':phoneNumber')
  get(): string {
    return 'ok';
  }

  @Get(':id/bad')
  bad(): never {
    throw new BadRequestException();
  }

  @Get(':id/fail')
  fail(): never {
    throw new InternalServerErrorException();
  }
}

async function createApp(enabled = true): Promise<INestApplication<App>> {
  @Module({
    imports: [HttpAccessLogModule],
    controllers: [HealthController, ProbeController],
  })
  class ProbeModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [ProbeModule],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(configWith(enabled))
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: false,
  });
  await app.init();
  return app;
}

function accessLines(lines: Line[]): Line[] {
  return lines.filter((line) => line.module === 'HttpAccess');
}

describe('HttpAccessLogMiddleware', () => {
  let app: INestApplication<App> | undefined;
  let lines: Line[];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    Logger.overrideLogger(true);
  });

  async function setup(enabled = true): Promise<INestApplication<App>> {
    app = await createApp(enabled);
    lines = captureLogs();
    return app;
  }

  it('응답이 끝나면 경로 템플릿으로 INFO 한 줄을 남기고 실제 값·쿼리는 남기지 않는다', async () => {
    const server = (await setup()).getHttpServer();

    await request(server).get('/probe/01012345678?token=secret').expect(200);

    const logged = accessLines(lines);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: 'INFO',
      service: 'expo-test',
      module: 'HttpAccess',
    });
    expect(logged[0].message).toMatch(/^GET \/probe\/:phoneNumber 200 \d+ms$/);
    const raw = JSON.stringify(logged);
    expect(raw).not.toContain('01012345678');
    expect(raw).not.toContain('secret');
  });

  it('4xx는 WARN, 5xx는 ERROR로 남긴다', async () => {
    const server = (await setup()).getHttpServer();

    await request(server).get('/probe/7/bad').expect(400);
    await request(server).get('/probe/7/fail').expect(500);

    const logged = accessLines(lines);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ level: 'WARN' });
    expect(logged[0].message).toMatch(/^GET \/probe\/:id\/bad 400 \d+ms$/);
    expect(logged[1]).toMatchObject({ level: 'ERROR' });
    expect(logged[1].message).toMatch(/^GET \/probe\/:id\/fail 500 \d+ms$/);
  });

  it('매칭된 라우트가 없으면 쿼리를 뗀 원래 경로를 200자까지만 남긴다', async () => {
    const server = (await setup()).getHttpServer();
    const long = `/nope/${'a'.repeat(300)}`;

    await request(server).get('/nope/abc?phoneNumber=01012345678').expect(404);
    await request(server).get(long).expect(404);

    const logged = accessLines(lines);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ level: 'WARN' });
    expect(logged[0].message).toMatch(/^GET \/nope\/abc 404 \d+ms$/);
    expect(JSON.stringify(logged)).not.toContain('01012345678');
    expect(logged[1].message).toBe(
      `GET ${long.slice(0, 200)} 404 ${/ (\d+)ms$/.exec(logged[1].message as string)?.[1]}ms`,
    );
  });

  it('상태 확인과 Swagger 경로는 남기지 않는다', async () => {
    const server = (await setup()).getHttpServer();

    await request(server).get('/').expect(200);
    await request(server).get('/sms/docs/swagger-ui.css');
    await request(server).get('/sms/v3/api-docs');

    expect(accessLines(lines)).toHaveLength(0);
  });

  it('HTTP_ACCESS_LOG_ENABLED=false로 꺼져 있으면 남기지 않는다', async () => {
    const server = (await setup(false)).getHttpServer();

    await request(server).get('/probe/1').expect(200);

    expect(accessLines(lines)).toHaveLength(0);
  });

  describe('연결 이벤트', () => {
    function fakeExchange() {
      const req = {
        method: 'POST',
        originalUrl: '/probe/1?code=1234',
        baseUrl: '',
      } as unknown as Request;
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableFinished: false,
      });
      const next = jest.fn();
      new HttpAccessLogMiddleware(configWith(true)).use(
        req,
        res as unknown as Response,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
      return res;
    }

    it('응답 전에 클라이언트가 끊으면 499 ERROR 한 줄만 남긴다', () => {
      lines = captureLogs();
      const res = fakeExchange();

      res.emit('close');
      res.emit('finish');

      const logged = accessLines(lines);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ level: 'ERROR' });
      expect(logged[0].message).toMatch(/^POST \/probe\/1 499 \d+ms$/);
    });

    it('정상 종료 뒤의 close로는 한 번 더 남기지 않는다', () => {
      lines = captureLogs();
      const res = fakeExchange();

      res.writableFinished = true;
      res.emit('finish');
      res.emit('close');

      const logged = accessLines(lines);
      expect(logged).toHaveLength(1);
      expect(logged[0].message).toMatch(/^POST \/probe\/1 200 \d+ms$/);
    });
  });
});
