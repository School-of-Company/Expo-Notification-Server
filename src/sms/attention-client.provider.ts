import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { InternalCallError, postInternal } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { ParticipationType } from './participation-type';

const qrImageResponse = z.object({ url: z.url() });

@Injectable()
export class AttentionClientProvider {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async createQrImage(request: {
    participationType: ParticipationType;
    id: number;
    phoneNumber: string;
  }): Promise<string> {
    const response = await postInternal(
      'attention',
      this.config.attention.baseUrl,
      '/internal/qr-images',
      this.config.attention.internalToken,
      request,
    );
    const parsed = qrImageResponse.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new InternalCallError(
        'attention returned an invalid qr image body',
      );
    }
    return parsed.data.url;
  }
}
