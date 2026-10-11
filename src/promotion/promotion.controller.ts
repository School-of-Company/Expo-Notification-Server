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
export class PromotionController {
  constructor(
    private readonly store: PromotionStore,
    private readonly service: PromotionService,
  ) {}

  @Get(':eventId')
  async get(@Param('eventId', new ZodValidationPipe(idSchema)) id: string) {
    const record = await this.store.get(id);
    if (!record) throw new NotFoundException();
    return record;
  }

  @Post(':eventId/reconciliation')
  async reconcile(
    @Param('eventId', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(reconcileSchema))
    body: z.infer<typeof reconcileSchema>,
  ) {
    if (!(await this.store.get(id))) throw new NotFoundException();
    await this.service.process(id, body.messageId);
    return this.store.get(id);
  }
}
