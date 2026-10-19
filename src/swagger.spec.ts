import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SmsController } from './sms/sms.controller';
import { SmsAuthService } from './sms/sms-auth.service';
import { APP_CONFIG } from './config/app-config.constants';
import { createAppConfig } from '../test/fixtures/app-config.fixture';

describe('Swagger operation security', () => {
  it('보호 상태 확인만 bearerAuth를 선언하고 공개 SMS operation은 선언하지 않는다', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController, SmsController],
      providers: [
        AppService,
        { provide: SmsAuthService, useValue: {} },
        { provide: APP_CONFIG, useValue: createAppConfig() },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(document.paths['/'].get?.security).toEqual([{ bearerAuth: [] }]);
      expect(document.paths['/sms'].get?.security).toBeUndefined();
      expect(document.paths['/sms'].post?.security).toBeUndefined();
      expect(document.paths['/sms/verify'].post?.security).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
