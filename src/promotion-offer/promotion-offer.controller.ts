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
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PromotionReconciliationDto } from '../promotion/promotion-reconciliation.dto';
import { PromotionOfferService } from './promotion-offer.service';
import { PromotionOfferStore } from './promotion-offer.store';

@Injectable()
export class PromotionOfferInternalGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const actual = request.headers['x-internal-token'];
    const config = this.config.promotionOffer;
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

@Controller('internal/promotion-offer-notifications')
@UseGuards(PromotionOfferInternalGuard)
@ApiTags('내부 참여 제안 알림')
@ApiSecurity('internalToken')
@ApiParam({
  name: 'eventId',
  description: '참여 제안 이벤트 ID (합성 예시)',
  format: 'uuid',
  example: '00000000-0000-4000-8000-000000000002',
})
@ApiResponse({ status: 400, description: '이벤트 ID 또는 요청 본문 형식 오류' })
@ApiResponse({
  status: 403,
  description: '기능 비활성화 또는 내부 토큰 누락·불일치',
})
@ApiResponse({ status: 404, description: '참여 제안 알림 기록 없음' })
export class PromotionOfferController {
  constructor(
    private readonly store: PromotionOfferStore,
    private readonly service: PromotionOfferService,
  ) {}

  @Get(':eventId')
  @ApiOperation({ summary: '참여 제안 알림 처리 상태 조회' })
  @ApiResponse({ status: 200, description: '이벤트와 처리 상태 반환' })
  async get(@Param('eventId', new ZodValidationPipe(idSchema)) id: string) {
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException();
    return record;
  }

  @Post(':eventId/reconciliation')
  @ApiOperation({
    summary: '접수 불명 참여 제안 수동 대사',
    description:
      '발송 업체 메시지 ID로 전달 결과만 확인합니다. 다시 보내지 않으며 접수 시각을 추정하지 않습니다.',
  })
  @ApiResponse({ status: 201, description: '대사 후 처리 상태 반환' })
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
