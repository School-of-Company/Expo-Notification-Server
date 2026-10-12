import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EurekaService } from '@school-of-company/nestjs-eureka';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { buildEurekaOptions } from './eureka-options.factory';
import { MetricsModule } from '../metrics/metrics.module';
import { MetricsProvider } from '../metrics/metrics.provider';

@Injectable()
class EurekaRegistrationProvider
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private service?: EurekaService;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MetricsProvider) private readonly metrics: MetricsProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Nest completes all onModuleInit hooks (including listener bind) first.
    const options = buildEurekaOptions(
      this.config,
      undefined,
      this.metrics.address,
    );
    if (!options) return;
    this.service = new EurekaService(options);
    try {
      await this.service.onApplicationBootstrap();
    } catch (error) {
      await this.metrics.onApplicationShutdown();
      throw error;
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.service?.beforeApplicationShutdown();
  }
}

@Module({
  imports: [MetricsModule],
  providers: [EurekaRegistrationProvider],
})
export class EurekaClientModule {}
