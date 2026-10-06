import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SmsAuthService } from './sms-auth.service';

const phoneNumber = z.string().regex(/^01\d{8,9}$/);

const sendCodeSchema = z.object({ phoneNumber });
const verifyCodeSchema = z.object({
  phoneNumber,
  code: z.string().regex(/^\d{4}$/),
});

@Controller('sms')
export class SmsController {
  constructor(private readonly smsAuthService: SmsAuthService) {}

  @Post()
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(sendCodeSchema))
  async sendCode(@Body() body: z.infer<typeof sendCodeSchema>): Promise<void> {
    await this.smsAuthService.sendCode(body.phoneNumber);
  }

  @Post('verify')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(verifyCodeSchema))
  async verifyCodeByBody(
    @Body() body: z.infer<typeof verifyCodeSchema>,
  ): Promise<void> {
    await this.smsAuthService.verifyCode(body.phoneNumber, body.code);
  }

  /** @deprecated 코드가 URL(접근 로그)에 남는다. `POST /sms/verify`를 쓴다. */
  @Get()
  @UsePipes(new ZodValidationPipe(verifyCodeSchema))
  async verifyCode(
    @Query() query: z.infer<typeof verifyCodeSchema>,
  ): Promise<void> {
    await this.smsAuthService.verifyCode(query.phoneNumber, query.code);
  }
}
