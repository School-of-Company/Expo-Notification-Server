import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { HttpAccessLogMiddleware } from './http-access-log.middleware';

@Module({ imports: [AppConfigModule] })
export class HttpAccessLogModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpAccessLogMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
