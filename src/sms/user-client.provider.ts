import { Inject, Injectable } from '@nestjs/common';
import { postInternal } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ParticipationType } from './participation-type';

@Injectable()
export class UserClientProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async recordSmsTry(request: {
    expoId: string;
    participationType: ParticipationType;
    phoneNumber: string;
  }): Promise<void> {
    await postInternal(
      'user',
      this.config.user.baseUrl,
      '/internal/participants/sms-try',
      this.config.user.internalToken,
      request,
    );
  }
}
