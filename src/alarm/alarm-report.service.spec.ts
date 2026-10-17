import { createAppConfig } from '../../test/fixtures/app-config.fixture';
import { AlarmReportService } from './alarm-report.service';
import { ApplicantCountProvider } from './applicant-count.provider';
import { DiscordEmbed, DiscordProvider } from './discord.provider';
import { ExpoStatStore } from './expo-stat.store';

const counts = [
  { expoId: 'a', title: 'A 박람회', applicationPerson: 10 },
  { expoId: 'b', title: 'B 박람회', applicationPerson: 3 },
];

describe('AlarmReportService', () => {
  let store: { findYesterday: jest.Mock; saveYesterday: jest.Mock };
  let applicantCounts: { isConfigured: jest.Mock; findAll: jest.Mock };
  let discord: { sendEmbeds: jest.Mock };

  const create = (
    discordConfig: { participantNumberUrl?: string } = {
      participantNumberUrl: 'https://discord.test/hook',
    },
  ) =>
    new AlarmReportService(
      createAppConfig({ discord: discordConfig }),
      store as unknown as ExpoStatStore,
      applicantCounts as unknown as ApplicantCountProvider,
      discord as unknown as DiscordProvider,
    );

  beforeEach(() => {
    store = {
      findYesterday: jest.fn().mockResolvedValue([4, 3]),
      saveYesterday: jest.fn(),
    };
    applicantCounts = {
      isConfigured: jest.fn().mockReturnValue(true),
      findAll: jest.fn().mockResolvedValue(counts),
    };
    discord = { sendEmbeds: jest.fn() };
  });

  it('이벤트 없이 내부 API 인원만으로 박람회별 임베드를 한 번에 보낸다 (#54 재현)', async () => {
    await create().sendParticipantNumberReport(
      new Date('2026-10-06T16:00:00Z'),
    );

    expect(store.findYesterday).toHaveBeenCalledWith(['a', 'b']);
    expect(discord.sendEmbeds).toHaveBeenCalledTimes(1);
    const [url, embeds] = discord.sendEmbeds.mock.calls[0] as [
      string,
      DiscordEmbed[],
    ];
    expect(url).toBe('https://discord.test/hook');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].fields[2].name).toBe('2026-10-07 박람회 등록 인원');
    expect(embeds[0].fields[3].value).toBe('+6');
    expect(embeds[1].fields[3].value).toBe('+0');
  });

  it('진행 중·예정 박람회가 없으면 발송하지 않는다', async () => {
    applicantCounts.findAll.mockResolvedValue([]);

    await create().sendParticipantNumberReport();

    expect(discord.sendEmbeds).not.toHaveBeenCalled();
  });

  it('인원 조회나 발송이 실패해도 던지지 않는다 (다음 정각에 다시 보낸다)', async () => {
    applicantCounts.findAll.mockRejectedValueOnce(new Error('user 503'));
    await expect(
      create().sendParticipantNumberReport(),
    ).resolves.toBeUndefined();
    expect(discord.sendEmbeds).not.toHaveBeenCalled();

    discord.sendEmbeds.mockRejectedValue(new Error('discord 500'));
    await expect(
      create().sendParticipantNumberReport(),
    ).resolves.toBeUndefined();
  });

  it('webhook URL이 없으면 조회도 발송도 하지 않는다', async () => {
    await create({}).sendParticipantNumberReport();

    expect(applicantCounts.findAll).not.toHaveBeenCalled();
    expect(discord.sendEmbeds).not.toHaveBeenCalled();
  });

  it('expo/user 내부 API가 설정되지 않으면 리포트와 스냅샷을 건너뛴다', async () => {
    applicantCounts.isConfigured.mockReturnValue(false);

    await create().sendParticipantNumberReport();
    await create().saveYesterdayApplicantCount();

    expect(applicantCounts.findAll).not.toHaveBeenCalled();
    expect(store.saveYesterday).not.toHaveBeenCalled();
  });

  it('자정 스냅샷은 조회한 현재 인원을 어제 인원으로 저장한다', async () => {
    await create().saveYesterdayApplicantCount();

    expect(store.saveYesterday).toHaveBeenCalledWith('a', 10);
    expect(store.saveYesterday).toHaveBeenCalledWith('b', 3);
  });
});
