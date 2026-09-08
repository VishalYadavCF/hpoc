import 'reflect-metadata';
import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerModule } from './scheduler/scheduler.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerModule);
  app.enableShutdownHooks();

  const port = Number(process.env['HEALTH_PORT'] ?? 3002);
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: req.url === '/healthz' ? 'ok' : 'not_found' }));
  });
  server.listen(port);

  const shutdown = async (): Promise<void> => {
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  new Logger('scheduler').log(`health on :${port}`);
}

await bootstrap();
