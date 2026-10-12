import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { APP_CONFIG } from './config/app-config.constants';
import { setupSwagger } from './swagger';

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
void bootstrap();
