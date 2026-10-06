import { Inject, Injectable } from '@nestjs/common';
import { SolapiMessageService } from 'solapi';
import { SOLAPI_CLIENT } from './sms.constants';

export interface OutgoingSms {
  to: string;
  from: string;
  text: string;
}

export interface SmsSendResult {
  total: number;
  failedTo: string[];
}

export class SmsDeliveryError extends Error {}

@Injectable()
export class SmsSenderProvider {
  constructor(
    @Inject(SOLAPI_CLIENT) private readonly client: SolapiMessageService,
  ) {}

  async send(messages: OutgoingSms[]): Promise<SmsSendResult> {
    try {
      const response = await this.client.send(messages);
      return {
        total: messages.length,
        failedTo: response.failedMessageList.map((failed) => failed.to),
      };
    } catch (error) {
      const failed = (error as { failedMessageList?: { to: string }[] })
        .failedMessageList;
      if (Array.isArray(failed)) {
        return { total: messages.length, failedTo: failed.map((m) => m.to) };
      }
      throw new SmsDeliveryError('sms gateway request failed');
    }
  }
}
