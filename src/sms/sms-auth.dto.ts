import { ApiProperty } from '@nestjs/swagger';

export class SendCodeDto {
  @ApiProperty({
    description: '인증 문자를 받을 휴대전화 번호 (합성 예시)',
    example: '01000000000',
    pattern: '^01\\d{8,9}$',
  })
  phoneNumber!: string;
}

export class VerifyCodeDto extends SendCodeDto {
  @ApiProperty({
    description: '문자로 받은 네 자리 인증번호 (합성 예시)',
    example: '0000',
    pattern: '^\\d{4}$',
  })
  code!: string;
}
