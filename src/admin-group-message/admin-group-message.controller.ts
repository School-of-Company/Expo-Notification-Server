import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  authorizeGroupMessageSchema,
  createGroupMessagePreviewSchema,
  groupMessageBindingSchema,
} from './admin-group-message.schema';
import { AdminGroupMessageService } from './admin-group-message.service';

@Injectable()
export class AdminGroupMessageInternalGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const actual = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>().headers[
      'x-internal-token'
    ];
    const expectedValue = this.config.adminGroupMessaging?.internalToken;
    if (typeof actual !== 'string' || !expectedValue) return false;
    const expected = Buffer.from(expectedValue);
    const supplied = Buffer.from(actual);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }
}

const previewIdSchema = z.uuid();
const jobIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

@Controller('internal/admin-group-messages')
@UseGuards(AdminGroupMessageInternalGuard)
export class AdminGroupMessageController {
  constructor(private readonly service: AdminGroupMessageService) {}

  @Get('config')
  config() {
    return this.service.configResponse();
  }

  @Post('previews')
  createPreview(
    @Body(new ZodValidationPipe(createGroupMessagePreviewSchema))
    body: z.infer<typeof createGroupMessagePreviewSchema>,
  ) {
    return this.service.createPreview(body);
  }

  @Post('previews/:previewId/jobs')
  @HttpCode(202)
  execute(
    @Param('previewId', new ZodValidationPipe(previewIdSchema))
    previewId: string,
    @Body(new ZodValidationPipe(authorizeGroupMessageSchema))
    body: z.infer<typeof authorizeGroupMessageSchema>,
  ) {
    return this.service.execute(previewId, body);
  }

  @Get('jobs/:jobId')
  getJob(
    @Param('jobId', new ZodValidationPipe(jobIdSchema)) jobId: string,
    @Query(new ZodValidationPipe(groupMessageBindingSchema))
    query: z.infer<typeof groupMessageBindingSchema>,
  ) {
    return this.service.getJob(jobId, query);
  }

  @Post('jobs/:jobId/retries')
  @HttpCode(202)
  retry(
    @Param('jobId', new ZodValidationPipe(jobIdSchema)) jobId: string,
    @Body(new ZodValidationPipe(authorizeGroupMessageSchema))
    body: z.infer<typeof authorizeGroupMessageSchema>,
  ) {
    return this.service.retryFailures(jobId, body);
  }
}
