import { Inject, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsProvider } from './metrics.provider';

const STANDARD_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    @Inject(MetricsProvider) private readonly metrics: MetricsProvider,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.metrics.address) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    const middlewareRoute: unknown = req.route;
    res.once('finish', () => {
      // Express route metadata is framework-owned; never fall back to req.url.
      const route: unknown = req.route;
      const path =
        route !== middlewareRoute &&
        typeof route === 'object' &&
        route !== null &&
        'path' in route
          ? route.path
          : undefined;
      this.metrics.observe({
        method: STANDARD_METHODS.has(req.method) ? req.method : 'OTHER',
        status: String(res.statusCode),
        uri: typeof path === 'string' ? path : 'unmatched',
        seconds: Number(process.hrtime.bigint() - started) / 1e9,
      });
    });
    next();
  }
}
