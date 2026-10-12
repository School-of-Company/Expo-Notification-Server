import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Param,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { groupMessageHistoryQuerySchema } from './admin-group-message-history.schema';
import { AdminGroupMessageHistoryService } from './admin-group-message-history.service';

@Injectable()
export class AdminGroupMessageHistoryInternalGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedValue = this.config.adminGroupMessaging?.internalToken;
    if (!expectedValue)
      throw new ServiceUnavailableException(
        'group message history unavailable',
      );
    const actual = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>().headers[
      'x-internal-token'
    ];
    if (typeof actual !== 'string') throw new UnauthorizedException();
    const expected = Buffer.from(expectedValue);
    const supplied = Buffer.from(actual);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new UnauthorizedException();
    return true;
  }
}

const expoIdSchema = z.uuid();
const historyResponseSchema = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'eventId',
          'type',
          'adminId',
          'occurredAt',
          'targetScope',
          'counts',
          'status',
          'jobId',
        ],
        properties: {
          eventId: { type: 'string', format: 'uuid' },
          type: { enum: ['REQUESTED', 'SENT', 'FAILED', 'RETRIED'] },
          adminId: { type: 'integer' },
          occurredAt: { type: 'string', format: 'date-time' },
          targetScope: {
            type: 'object',
            required: ['kind', 'applicationCount', 'programTypes'],
            properties: {
              kind: { type: 'string', enum: ['EXPLICIT_TARGETS'] },
              applicationCount: {
                type: 'integer',
                nullable: true,
                minimum: 1,
              },
              programTypes: {
                type: 'array',
                items: { type: 'string', enum: ['STANDARD', 'TRAINING'] },
              },
            },
          },
          counts: {
            type: 'object',
            required: [
              'total',
              'pending',
              'accepted',
              'delivered',
              'failed',
              'unknown',
              'missing',
            ],
            properties: Object.fromEntries(
              [
                'total',
                'pending',
                'accepted',
                'delivered',
                'failed',
                'unknown',
                'missing',
              ].map((name) => [name, { type: 'integer', minimum: 0 }]),
            ),
          },
          status: {
            type: 'string',
            enum: [
              'QUEUED',
              'RUNNING',
              'PAUSED',
              'COMPLETED',
              'COMPLETED_WITH_FAILURES',
              'ATTENTION',
            ],
          },
          jobId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
    },
    nextCursor: { type: 'string' },
  },
};

@Controller('internal/admin-group-messages/expos/:expoId/history')
@UseGuards(AdminGroupMessageHistoryInternalGuard)
@ApiTags('내부 관리자 그룹 발송')
@ApiSecurity('internalToken')
@ApiResponse({ status: 401, description: '내부 토큰 누락 또는 불일치' })
export class AdminGroupMessageHistoryController {
  constructor(private readonly service: AdminGroupMessageHistoryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['REQUESTED', 'SENT', 'FAILED', 'RETRIED'],
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, schema: historyResponseSchema })
  @ApiResponse({
    status: 400,
    description: '잘못된 행사 ID, 기간, 유형 또는 커서',
  })
  @ApiResponse({ status: 503, description: '이력 저장소를 사용할 수 없음' })
  list(
    @Param('expoId', new ZodValidationPipe(expoIdSchema)) expoId: string,
    @Query(new ZodValidationPipe(groupMessageHistoryQuerySchema))
    query: z.infer<typeof groupMessageHistoryQuerySchema>,
  ) {
    return this.service.list(expoId, query);
  }
}
