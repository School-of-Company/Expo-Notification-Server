import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { postInternal } from '../common/internal-http';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);
const dateTime = z.iso.datetime({ offset: true });
const period = {
  startedAt: dateTime.optional(),
  endedAt: dateTime.optional(),
};

const noticeResponse = z.array(
  z.object({
    participantId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sessions: z
      .array(
        z.object({
          title: label(100),
          ...period,
          place: label(255).nullable().optional(),
        }),
      )
      .max(10),
    programs: z
      .array(
        z.object({
          programType: z.enum(['STANDARD', 'TRAINING']),
          title: label(100),
          ...period,
          location: label(255).nullable().optional(),
        }),
      )
      .max(20),
  }),
);

export interface NoticeSession {
  readonly title: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly place?: string | null;
}
export interface NoticeProgram {
  readonly title: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly location?: string | null;
}
export interface ParticipantNotice {
  readonly sessions: readonly NoticeSession[];
  readonly programs: readonly NoticeProgram[];
}

// 이름 조회처럼 부가 정보라서 오래 기다리지 않는다.
const NOTICE_TIMEOUT_MS = 2_000;

/**
 * 참가자별로 확정된 회차와 신청 프로그램을 Application에서 읽는다(`POST /internal/expos/{expoId}/participants/notice-items`, #136).
 * 부가 정보라서 꺼져 있거나 읽지 못하면 빈 결과를 돌려주고, 호출한 쪽은 링크만 보낸다.
 */
@Injectable()
export class ParticipantNoticeProvider {
  private readonly logger = new Logger(ParticipantNoticeProvider.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async findNotices(request: {
    readonly expoId: string;
    readonly participantIds: readonly number[];
  }): Promise<ReadonlyMap<number, ParticipantNotice>> {
    const connection = this.application();
    if (!this.config.sms.qrNotice.enabled || !connection) return new Map();
    try {
      const response = await postInternal(
        'application',
        connection.baseUrl,
        `/internal/expos/${encodeURIComponent(request.expoId)}/participants/notice-items`,
        connection.internalToken,
        { participantIds: request.participantIds },
        NOTICE_TIMEOUT_MS,
      );
      const parsed = noticeResponse.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.length !== request.participantIds.length ||
        parsed.data.some(
          (item, index) => item.participantId !== request.participantIds[index],
        )
      ) {
        this.logger.warn('참가자 신청 내역 응답이 잘못되어 링크만 발송');
        return new Map();
      }
      return new Map(
        parsed.data.map(({ participantId, sessions, programs }) => [
          participantId,
          { sessions, programs },
        ]),
      );
    } catch {
      // 신청 내역은 선택 정보다. 네트워크/JSON 오류의 원문에는 개인정보가 있을 수 있다.
      this.logger.warn('참가자 신청 내역 조회 실패로 링크만 발송');
      return new Map();
    }
  }

  // Application 연결을 새로 만들지 않고 기존 연결을 재사용한다(알림 리포트와 같다, #68).
  private application() {
    return (
      this.config.promotionOffer?.application ??
      this.config.promotion?.application
    );
  }
}
