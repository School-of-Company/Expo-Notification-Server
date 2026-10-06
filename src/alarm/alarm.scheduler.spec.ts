import { AlarmJobLockStore } from './alarm-job-lock.store';
import { AlarmReportService } from './alarm-report.service';
import { AlarmScheduler } from './alarm.scheduler';

describe('AlarmScheduler', () => {
  let report: {
    sendParticipantNumberReport: jest.Mock;
    saveYesterdayApplicantCount: jest.Mock;
  };
  let lock: { acquire: jest.Mock };
  let scheduler: AlarmScheduler;

  beforeEach(() => {
    report = {
      sendParticipantNumberReport: jest.fn(),
      saveYesterdayApplicantCount: jest.fn(),
    };
    lock = { acquire: jest.fn().mockResolvedValue(true) };
    scheduler = new AlarmScheduler(
      report as unknown as AlarmReportService,
      lock as unknown as AlarmJobLockStore,
    );
  });

  it('락을 잡으면 리포트를 보낸다', async () => {
    await scheduler.sendParticipantNumberReport();

    expect(lock.acquire).toHaveBeenCalledWith('participant-report', 55);
    expect(report.sendParticipantNumberReport).toHaveBeenCalled();
  });

  it('다른 인스턴스가 락을 잡고 있으면 리포트를 건너뛴다 (중복 발송 방지)', async () => {
    lock.acquire.mockResolvedValue(false);

    await scheduler.sendParticipantNumberReport();

    expect(report.sendParticipantNumberReport).not.toHaveBeenCalled();
  });

  it('스냅샷도 작업별 락을 쓰고 락을 못 잡으면 건너뛴다', async () => {
    await scheduler.saveYesterdayApplicantCount();
    expect(lock.acquire).toHaveBeenCalledWith('yesterday-snapshot', 55);
    expect(report.saveYesterdayApplicantCount).toHaveBeenCalledTimes(1);

    lock.acquire.mockResolvedValue(false);
    await scheduler.saveYesterdayApplicantCount();
    expect(report.saveYesterdayApplicantCount).toHaveBeenCalledTimes(1);
  });
});
