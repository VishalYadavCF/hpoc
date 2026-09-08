import 'reflect-metadata';
import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';
import { Metrics } from './platform/observability/metrics.js';

/**
 * No HTTP framework here: a worker holds runs, not requests. The bare server exists only
 * so an orchestrator can probe liveness and scrape queue depth.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const metrics = app.get(Metrics);

  const port = Number(process.env['HEALTH_PORT'] ?? 3001);
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }
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

  new Logger('worker').log(`health on :${port}`);
}

await bootstrap();
