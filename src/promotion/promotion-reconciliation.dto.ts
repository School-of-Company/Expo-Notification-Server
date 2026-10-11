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
