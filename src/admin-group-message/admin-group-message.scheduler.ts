import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG } from '../config/app-config.constants';
import type { AppConfig } from '../config/app-config';
import { AdminGroupMessageService } from './admin-group-message.service';
import { AdminGroupMessageStore } from './admin-group-message.store';

@Injectable()
export class AdminGroupMessageScheduler {
  private readonly logger = new Logger(AdminGroupMessageScheduler.name);
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: AdminGroupMessageStore,
    private readonly service: AdminGroupMessageService,
  ) {}

  @Interval(1000)
  async dispatch(): Promise<void> {
    if (!this.config.adminGroupMessaging?.enabled || this.running) return;
    this.running = true;
    try {
      for (const id of await this.store.due()) {
        try {
          for (let sent = 0; sent < 100; sent += 1) {
            if (!(await this.service.process(id))) break;
          }
        } catch (error) {
          this.logger.error(
            `관리자 그룹 발송 작업 처리 실패: jobId=${id}`,
            error instanceof Error ? error.message : undefined,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
