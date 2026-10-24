import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { APP_CONFIG } from './config/app-config.constants';
import { EUREKA_APP_NAME } from './eureka/eureka-options.factory';
import { createPino, JsonLogger, readLogEnv } from './logging/json-logger';
import { setupSwagger } from './swagger';

// Installed before Nest exists so config loading and fail-fast exits are JSON too.
Logger.overrideLogger(
  new JsonLogger(createPino({ service: EUREKA_APP_NAME, ...readLogEnv() })),
);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  try {
    app.enableShutdownHooks();
    setupSwagger(app);
    await app.listen(app.get<AppConfig>(APP_CONFIG).port);
  } catch (error) {
    await app.close();
    throw error;
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').fatal(err instanceof Error ? err : String(err));
  process.exit(1);
});
