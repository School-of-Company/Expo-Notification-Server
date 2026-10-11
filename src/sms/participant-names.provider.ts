import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { postInternal } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const namesResponse = z.array(
  z.object({
    participantId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u),
  }),
);
const NAMES_TIMEOUT_MS = 2_000;

@Injectable()
export class ParticipantNamesProvider {
  private readonly logger = new Logger(ParticipantNamesProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async findNames(request: {
    readonly expoId: string;
    readonly participantIds: readonly number[];
  }): Promise<ReadonlyMap<number, string>> {
    if (!this.config.user) return new Map();
    try {
      const response = await postInternal(
        'user',
        this.config.user.baseUrl,
        '/internal/standard-participants/names',
        this.config.user.internalToken,
        request,
        NAMES_TIMEOUT_MS,
      );
      const body: unknown = await response.json();
      const parsed = namesResponse.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.length !== request.participantIds.length ||
        parsed.data.some(
          (item, index) => item.participantId !== request.participantIds[index],
        )
      ) {
        this.logger.warn('참가자 이름 응답이 잘못되어 역할 라벨 사용');
        return new Map();
      }
      return new Map(
        parsed.data.map(({ participantId, name }) => [participantId, name]),
      );
    } catch {
      // 이름은 선택 정보다. 네트워크/JSON 오류의 원문에는 개인정보가 있을 수 있다.
      this.logger.warn('참가자 이름 조회 실패로 역할 라벨 사용');
      return new Map();
    }
  }
}
