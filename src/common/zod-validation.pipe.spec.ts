import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z.object({ phoneNumber: z.string().regex(/^01\d{8,9}$/) }),
  );

  it('유효한 값은 파싱 결과를 돌려준다', () => {
    expect(pipe.transform({ phoneNumber: '01012345678' })).toEqual({
      phoneNumber: '01012345678',
    });
  });

  it('유효하지 않으면 필드 경로가 담긴 400을 던진다', () => {
    let error: unknown;
    try {
      pipe.transform({ phoneNumber: 'abc' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).toContain('phoneNumber');
  });
});
