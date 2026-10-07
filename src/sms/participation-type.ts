import { z } from 'zod';

export const participationTypeSchema = z.enum(['STANDARD', 'TRAINEE']);
export type ParticipationType = z.infer<typeof participationTypeSchema>;

// User 서비스는 표기(하이픈)가 다른 번호를 같은 번호로 취급하므로 숫자만 남겨 검증한다.
export const normalizedPhoneNumber = z
  .string()
  .transform((value) => value.replace(/\D/g, ''))
  .pipe(z.string().regex(/^01\d{8,9}$/));
