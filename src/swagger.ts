import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfig } from './config/app-config';
import { APP_CONFIG } from './config/app-config.constants';

export function setupSwagger(app: INestApplication): void {
  const { enabled, includeInternal } = app.get<AppConfig>(APP_CONFIG).swagger;
  if (!enabled) return;

  const builder = new DocumentBuilder()
    .setTitle('박람회 알림 API')
    .setDescription('문자 인증 API입니다. 예시는 모두 합성 데이터입니다.')
    .setVersion('1.0');
  if (includeInternal) {
    builder.addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Internal-Token',
        description: '내부 서비스 인증 토큰',
      },
      'internalToken',
    );
  }
  const document = SwaggerModule.createDocument(app, builder.build());
  for (const path of Object.keys(document.paths)) {
    if (
      !includeInternal &&
      (path === '/internal' || path.startsWith('/internal/'))
    ) {
      delete document.paths[path];
    }
  }
  SwaggerModule.setup('sms/docs', app, document, {
    jsonDocumentUrl: 'sms/v3/api-docs',
    raw: ['json'],
  });
}
