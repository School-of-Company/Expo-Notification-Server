import { ApiProperty } from '@nestjs/swagger';

export class PromotionReconciliationDto {
  @ApiProperty({
    description: '발송 업체에서 확인한 메시지 ID (합성 예시)',
    example: 'synthetic-message-id',
    minLength: 1,
    maxLength: 100,
  })
  messageId!: string;
}

export class PromotionResumptionDto {
  @ApiProperty({
    description:
      '승인 근거 참조(운영 티켓·승인 기록 ID 등). 전화번호·이름·본문·비밀값은 넣지 않는다 (합성 예시)',
    example: 'OPS-2026-001',
    minLength: 1,
    maxLength: 100,
  })
  approvalRef!: string;
}
