import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { SwaggerModule } from '@nestjs/swagger';
import { ApiModule } from './api/api.module.js';
import { buildOpenApiDocument } from './api/openapi/openapi.js';

async function bootstrap(): Promise<void> {
  // Body parsing is registered by hand so the A2A surface can take larger bodies than the rest.
  const app = await NestFactory.create(ApiModule, { bufferLogs: false, bodyParser: false });

  // agentorchestratorsvc -- the production A2A client -- attaches the merchant's whole context
  // (pgConfig, onboarding state, account aliases, conversation history) to EVERY `message/send`,
  // and a real call measured 2.6 MB. Under the default 100 KB limit Express rejected it before
  // the controller ran; the orchestrator recorded an empty FAILED reply and nothing in hpoc
  // besides a PayloadTooLargeError said why. Scoped to /a2a so every other route keeps the
  // small default: a large body there is a mistake or an attack, not a caller's normal shape.
  app.use('/a2a', json({ limit: process.env['A2A_BODY_LIMIT'] ?? '10mb' }));
  // The defaults Nest would have registered, restated. A body the /a2a parser already read is
  // marked parsed and skipped here.
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));

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
