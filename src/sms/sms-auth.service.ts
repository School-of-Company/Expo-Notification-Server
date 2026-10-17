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
import { ExpoNameProvider } from '../common/expo-name.provider';
import { kakaoOptionsFor } from './kakao-message';
import { renderAuthCodeSms } from './sms-message.templates';
import { SmsAuthStore } from './sms-auth.store';
import { SmsSenderProvider } from './sms-sender.provider';

const notFound = () => new NotFoundException('인증 요청 내역이 없습니다.');

@Injectable()
export class SmsAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: SmsAuthStore,
    private readonly sender: SmsSenderProvider,
    private readonly expoNames: ExpoNameProvider,
  ) {}

  async sendCode(phoneNumber: string, expoId?: string): Promise<void> {
    const { authCodeTtlSeconds, authMaxSendCount, fromStandardNumber } =
      this.config.sms;

    const { count: sendCount, window } = await this.store.increaseSendCount(
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
    // 카운트 후 저장 전에 창이 만료됐다. 새 창을 몰래 열면 번호별 상한을 건너뛰므로 실패시킨다.
    if (!(await this.store.saveCode(phoneNumber, window, code))) {
      throw new HttpException(
        '인증 요청이 만료되었습니다. 다시 요청해주세요.',
        HttpStatus.CONFLICT,
      );
    }

    const { text, variables } = renderAuthCodeSms(
      await this.expoNames.titleOf(expoId),
      code,
    );
    const kakaoOptions = kakaoOptionsFor(
      this.config,
      this.config.kakao?.auto.authCode,
      variables,
    );
    const { failedTo } = await this.sender.send([
      {
        to: phoneNumber,
        from: fromStandardNumber,
        text,
        ...(kakaoOptions && { kakaoOptions }),
      },
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
      throw notFound();
    }
    // 비교 전에 원자적으로 시도 횟수를 먼저 올려, 동시 요청으로 상한을 우회하지 못하게 한다.
    const attempts = await this.store.increaseVerifyAttemptCount(
      phoneNumber,
      state.window,
    );
    if (attempts === null) {
      throw notFound();
    }
    if (attempts > this.config.sms.authMaxVerifyAttemptCount) {
      throw new HttpException(
        '인증 시도 횟수를 초과했습니다.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (state.code !== code) {
      throw new BadRequestException('인증번호가 일치하지 않습니다.');
    }
    if (!(await this.store.markVerified(phoneNumber, state.window))) {
      throw notFound();
    }
  }
}
