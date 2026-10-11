import {
  HttpException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { SmsAuthService } from './sms-auth.service';
import { SmsAuthStore } from './sms-auth.store';
import { SmsSenderProvider } from './sms-sender.provider';

describe('SmsAuthService', () => {
  const config = createAppConfig();
  let store: {
    increaseSendCount: jest.Mock;
    increaseGlobalSendCount: jest.Mock;
    saveCode: jest.Mock;
    find: jest.Mock;
    increaseVerifyAttemptCount: jest.Mock;
    markVerified: jest.Mock;
  };
  let sender: { send: jest.Mock };
  let service: SmsAuthService;

  beforeEach(() => {
    store = {
      increaseSendCount: jest.fn().mockResolvedValue(1),
      increaseGlobalSendCount: jest.fn().mockResolvedValue(1),
      saveCode: jest.fn(),
      find: jest.fn(),
      increaseVerifyAttemptCount: jest.fn().mockResolvedValue(1),
      markVerified: jest.fn(),
    };
    sender = { send: jest.fn().mockResolvedValue({ total: 1, failedTo: [] }) };
    service = new SmsAuthService(
      config,
      store as unknown as SmsAuthStore,
      sender as unknown as SmsSenderProvider,
    );
  });

  describe('sendCode', () => {
    it('4자리 숫자 코드를 저장하고 같은 코드를 일반 참가자 발신번호로 발송한다', async () => {
      await service.sendCode('01012345678');

      const [, savedCode] = store.saveCode.mock.calls[0] as [string, string];
      expect(savedCode).toMatch(/^\d{4}$/);
      expect(sender.send).toHaveBeenCalledWith([
        {
          to: '01012345678',
          from: config.sms.fromStandardNumber,
          text: savedCode,
        },
      ]);
      expect(store.increaseSendCount).toHaveBeenCalledWith('01012345678', 180);
    });

    it('요청 횟수 상한을 넘으면 429이고 발송하지 않는다', async () => {
      store.increaseSendCount.mockResolvedValue(
        config.sms.authMaxSendCount + 1,
      );

      await expect(service.sendCode('01012345678')).rejects.toMatchObject({
        status: 429,
      });
      expect(store.saveCode).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('전체 시간당 발송 상한을 넘으면 429이고 코드를 저장하거나 발송하지 않는다', async () => {
      store.increaseGlobalSendCount.mockResolvedValue(
        config.sms.authMaxSendCountPerHour + 1,
      );

      await expect(service.sendCode('01012345678')).rejects.toMatchObject({
        status: 429,
      });
      expect(store.saveCode).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('번호별 상한에 걸린 요청은 전체 카운터를 올리지 않는다', async () => {
      store.increaseSendCount.mockResolvedValue(
        config.sms.authMaxSendCount + 1,
      );

      await expect(service.sendCode('01012345678')).rejects.toMatchObject({
        status: 429,
      });
      expect(store.increaseGlobalSendCount).not.toHaveBeenCalled();
    });

    it('시간 버킷 단위(YYYY-MM-DDTHH)로 전체 카운터를 올린다', async () => {
      await service.sendCode('01012345678');

      expect(store.increaseGlobalSendCount).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}$/),
      );
    });

    it('상한과 같은 횟수까지는 허용한다', async () => {
      store.increaseSendCount.mockResolvedValue(config.sms.authMaxSendCount);

      await expect(service.sendCode('01012345678')).resolves.toBeUndefined();
    });

    it('문자 발송이 실패하면 502를 던진다', async () => {
      sender.send.mockResolvedValue({ total: 1, failedTo: ['01012345678'] });

      const error = await service
        .sendCode('01012345678')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(502);
    });
  });

  describe('verifyCode', () => {
    const state = { code: '0123', verified: false };

    it('코드가 맞으면 인증 완료로 표시한다', async () => {
      store.find.mockResolvedValue(state);

      await service.verifyCode('01012345678', '0123');

      expect(store.markVerified).toHaveBeenCalledWith('01012345678');
    });

    it('앞자리 0이 있는 코드를 숫자로 환산해 비교하지 않는다', async () => {
      store.find.mockResolvedValue(state);

      await expect(
        service.verifyCode('01012345678', '1230'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('인증 요청 내역이 없으면 404이고 시도 횟수를 올리지 않는다', async () => {
      store.find.mockResolvedValue(null);

      await expect(
        service.verifyCode('01012345678', '0123'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(store.increaseVerifyAttemptCount).not.toHaveBeenCalled();
    });

    it('코드가 틀리면 400이다', async () => {
      store.find.mockResolvedValue(state);

      await expect(
        service.verifyCode('01012345678', '9999'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.markVerified).not.toHaveBeenCalled();
    });

    it('비교 전에 시도 횟수를 먼저 올린다 (맞는 코드도 시도로 센다)', async () => {
      store.find.mockResolvedValue(state);

      await service.verifyCode('01012345678', '0123');

      expect(store.increaseVerifyAttemptCount).toHaveBeenCalledWith(
        '01012345678',
      );
    });

    it('시도 횟수가 상한을 넘으면 맞는 코드여도 429이고 인증되지 않는다', async () => {
      store.find.mockResolvedValue(state);
      store.increaseVerifyAttemptCount.mockResolvedValue(
        config.sms.authMaxVerifyAttemptCount + 1,
      );

      await expect(
        service.verifyCode('01012345678', '0123'),
      ).rejects.toMatchObject({
        status: 429,
      });
      expect(store.markVerified).not.toHaveBeenCalled();
    });

    it('상한과 같은 횟수째 시도까지는 비교한다', async () => {
      store.find.mockResolvedValue(state);
      store.increaseVerifyAttemptCount.mockResolvedValue(
        config.sms.authMaxVerifyAttemptCount,
      );

      await service.verifyCode('01012345678', '0123');

      expect(store.markVerified).toHaveBeenCalled();
    });
  });
});
