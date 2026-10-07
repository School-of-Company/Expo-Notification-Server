import { Module } from '@nestjs/common';
import { EurekaService } from '@school-of-company/nestjs-eureka';
import { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';
import { buildEurekaOptions } from './eureka-options.factory';

/**
 * `eureka.serviceUrl`이 설정되어 있을 때만 Eureka에 등록한다 (로컬 개발은 비워 두면 된다).
 * 설정 값은 config 서버에서 비동기로 받아오므로 정적 `EurekaModule.forRoot` 대신 팩토리에서 결정한다.
 */
@Module({
  providers: [
    {
      provide: EurekaService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const options = buildEurekaOptions(config);
        return options ? new EurekaService(options) : null;
      },
    },
  ],
})
export class EurekaClientModule {}
