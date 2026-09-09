import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { ApiModule } from './api/api.module.js';
import { buildOpenApiDocument } from './api/openapi/openapi.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { bufferLogs: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Served from the app itself rather than published as a static file, so the document
  // is generated from the router that is actually running. A checked-in spec is a
  // second source of truth, and the one that goes stale is always the written one.
  SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: 'docs/json',
    yamlDocumentUrl: 'docs/yaml',
    swaggerOptions: {
      // 151 routes: collapsed by default, or the page opens on a wall of text.
      docExpansion: 'none',
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });

  app.enableShutdownHooks();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  new Logger('api').log(`listening on :${port} — docs at /docs`);
}

await bootstrap();
