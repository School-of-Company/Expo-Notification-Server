import {
  applyDecorators,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PromotionService } from './promotion.service';
import { PromotionStore } from './promotion.store';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  PromotionReconciliationDto,
  PromotionResumptionDto,
} from './promotion-reconciliation.dto';
import {
  auditPromotionLedger,
  evaluateRedisReadiness,
} from './promotion-audit';

@Injectable()
export class PromotionInternalGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const actual = request.headers['x-internal-token'];
    const config = this.config.promotion;
    if (!config?.enabled || typeof actual !== 'string') return false;
    const expected = Buffer.from(config.internalToken);
    const supplied = Buffer.from(actual);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }
}

const idSchema = z.uuid();
const reconcileSchema = z
  .object({ messageId: z.string().min(1).max(100) })
  .strict();
const resumeSchema = z
  .object({
    approvalRef: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:#/-]*$/),
  })
  .strict();
const AUDIT_SCAN_LIMIT = 10_000;

@Controller('internal/promotion-notifications')
@UseGuards(PromotionInternalGuard)
@ApiTags('내부 승급 알림')
@ApiSecurity('internalToken')
@ApiResponse({ status: 400, description: '이벤트 ID 또는 요청 본문 형식 오류' })
@ApiResponse({
  status: 403,
  description: '기능 비활성화 또는 내부 토큰 누락·불일치',
})
@ApiResponse({ status: 500, description: '저장소 또는 재처리 오류' })
export class PromotionController {
  constructor(
    private readonly store: PromotionStore,
    private readonly service: PromotionService,
  ) {}

  // ':eventId'보다 먼저 선언해야 경로가 가려지지 않는다.
  @Get('ops/audit')
  @ApiOperation({
    summary: '승급 원장·Redis 운영 점검 (읽기 전용)',
    description:
      '상태별 건수, 대조가 필요한 이벤트, due ZSET 정합성, Redis AOF/noeviction/TTL 점검 결과를 반환합니다. 원장과 Redis 설정을 바꾸지 않습니다.',
  })
  @ApiResponse({ status: 200, description: '점검 결과 반환' })
  async audit() {
    const snapshot = await this.store.snapshot(AUDIT_SCAN_LIMIT);
    const ledger = auditPromotionLedger(snapshot);
    return {
      checkedAt: new Date().toISOString(),
      recoveryHold: this.service.held,
      ledger,
      redis: evaluateRedisReadiness(await this.store.redisSettings(), {
        dueTtl: snapshot.dueTtl,
        withTtl: ledger.withTtl.length,
      }),
    };
  }

  @Get(':eventId')
  @EventIdParam()
  @ApiOperation({ summary: '승급 알림 처리 상태 조회' })
  @ApiResponse({ status: 200, description: '승급 이벤트와 처리 상태 반환' })
  async get(@Param('eventId', new ZodValidationPipe(idSchema)) id: string) {
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException();
    return record;
  }

  @Post(':eventId/reconciliation')
  @EventIdParam()
  @ApiOperation({
    summary: '접수 불명 승급 알림 수동 대사',
    description: '발송 업체의 메시지 ID를 확인한 뒤 재처리합니다.',
  })
  @ApiResponse({ status: 201, description: '대사 후 승급 알림 처리 상태 반환' })
  async reconcile(
    @Param('eventId', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(reconcileSchema))
    body: PromotionReconciliationDto,
  ) {
    if (!(await this.store.get(id))) throw new NotFoundException();
    await this.service.process(id, body.messageId);
    return this.store.get(id);
  }

  @Post(':eventId/resumption')
  @EventIdParam()
  @ApiOperation({
    summary: '승급 알림 승인된 수동 재개',
    description:
      'messageId 없는 UNKNOWN/SENDING 또는 OPERATIONS를 승인 근거와 함께 PENDING으로 되돌립니다. 공급자 목록에 없다는 사실만으로 재개하지 않습니다. 복구 보류 중에는 보류를 풀 때까지 발송하지 않습니다.',
  })
  @ApiResponse({ status: 201, description: '재개 후 승급 알림 처리 상태 반환' })
  @ApiResponse({
    status: 409,
    description: '재개할 수 없는 상태이거나 다른 작업자가 처리 중',
  })
  async resume(
    @Param('eventId', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(resumeSchema)) body: PromotionResumptionDto,
  ) {
    const result = await this.service.resume(id, body.approvalRef);
    if (result === 'NOT_FOUND') throw new NotFoundException();
    if (result !== 'RESUMED') throw new ConflictException(result);
    return this.store.get(id);
  }
}

function EventIdParam(): MethodDecorator {
  return applyDecorators(
    ApiParam({
      name: 'eventId',
      description: '승급 이벤트 ID (합성 예시)',
      format: 'uuid',
      example: '00000000-0000-4000-8000-000000000001',
    }),
    ApiResponse({ status: 404, description: '승급 알림 기록 없음' }),
  );
}
