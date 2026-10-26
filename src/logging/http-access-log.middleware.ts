import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const MAX_RAW_PATH_LENGTH = 200;
/** 클라이언트가 응답 전에 끊은 요청 (nginx 관례). */
const CLIENT_CLOSED_STATUS = 499;

// GET / 는 상태 확인, 나머지는 Swagger(src/swagger.ts). /metrics 는 별도 리스너라 여기 오지 않는다.
const SKIPPED_PATHS = ['/'];
const SKIPPED_PREFIXES = ['/sms/docs', '/sms/v3/api-docs'];

export function isSkippedPath(path: string): boolean {
  return (
    SKIPPED_PATHS.includes(path) ||
    SKIPPED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

function rawPath(req: Request): string {
  const url = req.originalUrl ?? req.url ?? '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Matched Express route template (`/sms/:phoneNumber`) so ids and phone numbers
 * in paths never reach the log. Falls back to the raw path, without the query
 * string and truncated, when no route matched.
 */
function routeOf(req: Request, middlewareRoute: unknown): string {
  const route: unknown = req.route;
  if (
    route !== middlewareRoute &&
    typeof route === 'object' &&
    route !== null &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return `${req.baseUrl ?? ''}${route.path}`;
  }
  return rawPath(req).slice(0, MAX_RAW_PATH_LENGTH);
}

/**
 * One access line per HTTP request, written when the response finishes or the
 * client disconnects first (499). Only method, route template, status and
 * duration are logged — never headers, cookies, bodies, query strings or tokens.
 */
@Injectable()
export class HttpAccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpAccess');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.config.httpAccessLog.enabled || isSkippedPath(rawPath(req))) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    const middlewareRoute: unknown = req.route;
    let logged = false;
    const write = (status: number): void => {
      if (logged) return;
      logged = true;
      const ms = Math.round(
        Number(process.hrtime.bigint() - started) / 1_000_000,
      );
      const message = `${req.method} ${routeOf(req, middlewareRoute)} status: ${status} (${ms}ms)`;
      if (status >= 500 || status === CLIENT_CLOSED_STATUS) {
        this.logger.error(message);
      } else if (status >= 400) {
        this.logger.warn(message);
      } else {
        this.logger.log(message);
      }
    };
    res.once('finish', () => write(res.statusCode));
    res.once('close', () => {
      if (!res.writableFinished) write(CLIENT_CLOSED_STATUS);
    });
    next();
  }
}
