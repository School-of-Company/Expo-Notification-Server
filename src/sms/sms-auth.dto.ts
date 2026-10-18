import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class PhoneNumberDto {
  @ApiProperty({
    description: '인증 문자를 받을 휴대전화 번호 (합성 예시)',
    example: '01000000000',
    pattern: '^01\\d{8,9}$',
  })
  phoneNumber!: string;
}

export class SendCodeDto extends PhoneNumberDto {
  @ApiPropertyOptional({
    description:
      '박람회 ID. 받기만 하고 쓰지 않는다(승인된 인증 문구에 행사명이 고정).',
    example: '00000000-0000-0000-0000-000000000000',
    pattern: '^[A-Za-z0-9_-]{1,36}$',
  })
  expoId?: string;
}

export class VerifyCodeDto extends PhoneNumberDto {
  @ApiProperty({
    description: '문자로 받은 네 자리 인증번호 (합성 예시)',
    example: '0000',
    pattern: '^\\d{4}$',
  })
  code!: string;
}
