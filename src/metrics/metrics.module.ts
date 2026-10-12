import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsProvider } from './metrics.provider';

@Module({
  imports: [AppConfigModule],
  providers: [MetricsProvider],
  exports: [MetricsProvider],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpMetricsMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
