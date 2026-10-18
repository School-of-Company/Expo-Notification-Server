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
import { expoIdSchema } from '../common/expo-name.provider';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SmsAuthService } from './sms-auth.service';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SendCodeDto, VerifyCodeDto } from './sms-auth.dto';

const phoneNumber = z.string().regex(/^01\d{8,9}$/);

const sendCodeSchema = z.object({
  phoneNumber,
  // 승인된 K1 문구에 행사명이 고정돼 쓰지 않는다. 이미 보내는 클라이언트가 400을 받지 않게 받기만 한다.
  expoId: expoIdSchema.optional(),
});
const verifyCodeSchema = z.object({
  phoneNumber,
  code: z.string().regex(/^\d{4}$/),
});

@Controller('sms')
@ApiTags('문자 인증')
@ApiResponse({ status: 500, description: '저장소 또는 외부 발송 서비스 오류' })
export class SmsController {
  constructor(private readonly smsAuthService: SmsAuthService) {}

  @Post()
  @ApiOperation({ summary: '인증 문자 발송' })
  @ApiResponse({
    status: 200,
    description: '인증 문자 발송 완료 (응답 본문 없음)',
  })
  @ApiResponse({ status: 400, description: '휴대전화 번호 형식 오류' })
  @ApiResponse({
    status: 429,
    description: '번호별 또는 시간당 발송 횟수 초과',
  })
  @ApiResponse({
    status: 409,
    description: '처리 중 인증 요청 창이 만료됨 (문자 미발송, 다시 요청)',
  })
  @ApiResponse({ status: 502, description: '인증번호 발송 실패' })
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(sendCodeSchema))
  async sendCode(@Body() body: SendCodeDto): Promise<void> {
    await this.smsAuthService.sendCode(body.phoneNumber);
  }

  @Post('verify')
  @ApiOperation({ summary: '인증번호 검증' })
  @ApiResponse({ status: 200, description: '인증 완료 (응답 본문 없음)' })
  @ApiResponse({
    status: 400,
    description: '입력 형식 오류 또는 인증번호 불일치',
  })
  @ApiResponse({ status: 404, description: '인증 요청 내역 없음 또는 만료' })
  @ApiResponse({ status: 429, description: '인증 시도 횟수 초과' })
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(verifyCodeSchema))
  async verifyCodeByBody(@Body() body: VerifyCodeDto): Promise<void> {
    await this.smsAuthService.verifyCode(body.phoneNumber, body.code);
  }

  /** @deprecated 코드가 URL(접근 로그)에 남는다. `POST /sms/verify`를 쓴다. */
  @Get()
  @ApiOperation({
    summary: '인증번호 검증 (기존 쿼리 방식)',
    deprecated: true,
    description:
      '인증번호가 URL 로그에 남으므로 POST /sms/verify를 사용하세요.',
  })
  @ApiResponse({ status: 200, description: '인증 완료 (응답 본문 없음)' })
  @ApiResponse({
    status: 400,
    description: '입력 형식 오류 또는 인증번호 불일치',
  })
  @ApiResponse({ status: 404, description: '인증 요청 내역 없음 또는 만료' })
  @ApiResponse({ status: 429, description: '인증 시도 횟수 초과' })
  @UsePipes(new ZodValidationPipe(verifyCodeSchema))
  async verifyCode(@Query() query: VerifyCodeDto): Promise<void> {
    await this.smsAuthService.verifyCode(query.phoneNumber, query.code);
  }
}
