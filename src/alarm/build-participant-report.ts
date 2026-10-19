import { ExpoApplicantCount } from './applicant-count.provider';
import { DiscordEmbed } from './discord.provider';

export interface ExpoStat extends ExpoApplicantCount {
  yesterdayConfirmed: number;
}

const EMBED_COLOR_RED = 16711680;

const signed = (value: number) => (value >= 0 ? `+${value}` : String(value));

/** 직전 발송과 비교하는 표시 인원. 어제 인원·증감·날짜만 바뀐 경우는 다시 보내지 않는다. */
export function reportSignature(count: ExpoApplicantCount): string {
  return JSON.stringify([count.confirmed, count.waiting, count.sessions]);
}

// ponytail: Discord embed 필드는 25개까지라 회차가 20개를 넘으면 발송이 실패한다. 그때 회차를 한 필드로 합친다.
export function buildParticipantReport(
  stat: ExpoStat,
  today: string,
): DiscordEmbed {
  return {
    description: '박람회별 등록 인원 로그',
    color: EMBED_COLOR_RED,
    fields: [
      { name: '박람회 이름', value: stat.title },
      { name: '어제 박람회 등록 인원', value: String(stat.yesterdayConfirmed) },
      { name: `${today} 박람회 등록 인원`, value: String(stat.confirmed) },
      {
        name: '추가 등록 인원',
        value: signed(stat.confirmed - stat.yesterdayConfirmed),
      },
      { name: '대기 인원', value: String(stat.waiting) },
      ...stat.sessions.map((session) => ({
        name: `${session.title} 확정 인원`,
        value: String(session.confirmed),
      })),
    ],
  };
}
