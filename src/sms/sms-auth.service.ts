import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { SmsAuthStore } from './sms-auth.store';
import { SmsSenderProvider } from './sms-sender.provider';

@Injectable()
export class SmsAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: SmsAuthStore,
    private readonly sender: SmsSenderProvider,
  ) {}

  async sendCode(phoneNumber: string): Promise<void> {
    const { authCodeTtlSeconds, authMaxSendCount, fromStandardNumber } =
      this.config.sms;

    const sendCount = await this.store.increaseSendCount(
      phoneNumber,
      authCodeTtlSeconds,
    );
    if (sendCount > authMaxSendCount) {
      throw new HttpException(
        '인증번호 요청 횟수를 초과했습니다.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hourBucket = new Date().toISOString().slice(0, 13);
    const globalCount = await this.store.increaseGlobalSendCount(hourBucket);
    if (globalCount > this.config.sms.authMaxSendCountPerHour) {
      throw new HttpException(
        '인증번호 요청이 많습니다. 잠시 후 다시 시도해주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    await this.store.saveCode(phoneNumber, code);

    const { failedTo } = await this.sender.send([
      { to: phoneNumber, from: fromStandardNumber, text: code },
    ]);
    if (failedTo.length > 0) {
      throw new HttpException(
        '인증번호 발송에 실패했습니다.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async verifyCode(phoneNumber: string, code: string): Promise<void> {
    const state = await this.store.find(phoneNumber);
    if (!state) {
      throw new NotFoundException('인증 요청 내역이 없습니다.');
    }
    // 비교 전에 원자적으로 시도 횟수를 먼저 올려, 동시 요청으로 상한을 우회하지 못하게 한다.
    const attempts = await this.store.increaseVerifyAttemptCount(phoneNumber);
    if (attempts > this.config.sms.authMaxVerifyAttemptCount) {
      throw new HttpException(
        '인증 시도 횟수를 초과했습니다.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (state.code !== code) {
      throw new BadRequestException('인증번호가 일치하지 않습니다.');
    }
    await this.store.markVerified(phoneNumber);
  }
}
