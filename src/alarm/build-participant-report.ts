import { DiscordEmbed } from './discord.provider';
import { ExpoStat } from './expo-stat.store';

const EMBED_COLOR_RED = 16711680;

export function buildParticipantReport(
  stat: ExpoStat,
  today: string,
): DiscordEmbed {
  const difference = stat.applicationPerson - stat.yesterdayApplicationPerson;
  return {
    description: '박람회별 등록 인원 로그',
    color: EMBED_COLOR_RED,
    fields: [
      { name: '박람회 이름', value: stat.title },
      {
        name: '어제 박람회 등록 인원',
        value: String(stat.yesterdayApplicationPerson),
      },
      {
        name: `${today} 박람회 등록 인원`,
        value: String(stat.applicationPerson),
      },
      {
        name: '추가 등록 인원',
        value: difference >= 0 ? `+${difference}` : String(difference),
      },
    ],
  };
}
