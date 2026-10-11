import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AlarmReportService } from './alarm-report.service';
import { DiscordEmbed, DiscordProvider } from './discord.provider';
import { ExpoStatStore } from './expo-stat.store';

const stats = [
  {
    expoId: 'a',
    title: 'A 박람회',
    applicationPerson: 10,
    yesterdayApplicationPerson: 4,
  },
  {
    expoId: 'b',
    title: 'B 박람회',
    applicationPerson: 3,
    yesterdayApplicationPerson: 3,
  },
];

describe('AlarmReportService', () => {
  let store: {
    upsert: jest.Mock;
    findAll: jest.Mock;
    saveYesterday: jest.Mock;
  };
  let discord: { sendEmbeds: jest.Mock };

  const create = (
    discordConfig: { participantNumberUrl?: string } = {
      participantNumberUrl: 'https://discord.test/hook',
    },
  ) =>
    new AlarmReportService(
      createAppConfig({ discord: discordConfig }),
      store as unknown as ExpoStatStore,
      discord as unknown as DiscordProvider,
    );

  beforeEach(() => {
    store = {
      upsert: jest.fn(),
      findAll: jest.fn().mockResolvedValue(stats),
      saveYesterday: jest.fn(),
    };
    discord = { sendEmbeds: jest.fn() };
  });

  it('등록 인원 이벤트를 절대값 그대로 저장한다', async () => {
    await create().recordApplicantCount({
      eventId: 'e1',
      version: 1,
      expoId: 'a',
      expoTitle: 'A 박람회',
      applicationPerson: 42,
    });

    expect(store.upsert).toHaveBeenCalledWith('a', 'A 박람회', 42);
  });

  it('박람회별 임베드를 한 번에 모아 보낸다 (KST 날짜 기준)', async () => {
    await create().sendParticipantNumberReport(
      new Date('2026-10-06T16:00:00Z'),
    );

    expect(discord.sendEmbeds).toHaveBeenCalledTimes(1);
    const [url, embeds] = discord.sendEmbeds.mock.calls[0] as [
      string,
      DiscordEmbed[],
    ];
    expect(url).toBe('https://discord.test/hook');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].fields[2].name).toBe('2026-10-07 박람회 등록 인원');
    expect(embeds[0].fields[3].value).toBe('+6');
  });

  it('박람회가 없으면 발송하지 않는다', async () => {
    store.findAll.mockResolvedValue([]);

    await create().sendParticipantNumberReport();

    expect(discord.sendEmbeds).not.toHaveBeenCalled();
  });

  it('발송이 실패해도 던지지 않는다 (다음 정각에 다시 보낸다)', async () => {
    discord.sendEmbeds.mockRejectedValue(new Error('discord 500'));

    await expect(
      create().sendParticipantNumberReport(),
    ).resolves.toBeUndefined();
  });

  it('webhook URL이 없으면 조회도 발송도 하지 않는다', async () => {
    await create({}).sendParticipantNumberReport();

    expect(store.findAll).not.toHaveBeenCalled();
    expect(discord.sendEmbeds).not.toHaveBeenCalled();
  });

  it('자정 스냅샷은 모든 박람회의 현재 인원을 어제 인원으로 저장한다', async () => {
    await create().saveYesterdayApplicantCount();

    expect(store.saveYesterday).toHaveBeenCalledWith('a', 10);
    expect(store.saveYesterday).toHaveBeenCalledWith('b', 3);
  });
});
