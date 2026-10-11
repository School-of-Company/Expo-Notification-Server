import {
  Body,
  CanActivate,
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
import { PromotionReconciliationDto } from './promotion-reconciliation.dto';

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

@Controller('internal/promotion-notifications')
@UseGuards(PromotionInternalGuard)
@ApiTags('내부 승급 알림')
@ApiSecurity('internalToken')
@ApiParam({
  name: 'eventId',
  description: '승급 이벤트 ID (합성 예시)',
  format: 'uuid',
  example: '00000000-0000-4000-8000-000000000001',
})
@ApiResponse({ status: 400, description: '이벤트 ID 또는 요청 본문 형식 오류' })
@ApiResponse({
  status: 403,
  description: '기능 비활성화 또는 내부 토큰 누락·불일치',
})
@ApiResponse({ status: 404, description: '승급 알림 기록 없음' })
@ApiResponse({ status: 500, description: '저장소 또는 재처리 오류' })
export class PromotionController {
  constructor(
    private readonly store: PromotionStore,
    private readonly service: PromotionService,
  ) {}

  @Get(':eventId')
  @ApiOperation({ summary: '승급 알림 처리 상태 조회' })
  @ApiResponse({ status: 200, description: '승급 이벤트와 처리 상태 반환' })
  async get(@Param('eventId', new ZodValidationPipe(idSchema)) id: string) {
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException();
    return record;
  }

  @Post(':eventId/reconciliation')
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
}
