import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

interface Liveness {
  status: 'ok';
}

interface Readiness {
  status: 'ok' | 'degraded';
  checks: { database: 'up' | 'down' };
}

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness. Deliberately checks nothing external: an orchestrator restarts
   * the process when this fails, and restarting does not fix a database that
   * is down - it just removes a working instance during an outage.
   */
  @Get()
  live(): Liveness {
    return { status: 'ok' };
  }

  /**
   * Readiness. Fails while the database is unreachable so the instance is
   * pulled out of the load balancer without being killed.
   *
   * Signals failure with a 503 rather than a 200 carrying a "degraded" body,
   * because probes read the status code and treat any 200 as healthy.
   */
  @Get('ready')
  async ready(): Promise<Readiness> {
    const database = (await this.prisma.ping()) ? 'up' : 'down';
    const body: Readiness = {
      status: database === 'up' ? 'ok' : 'degraded',
      checks: { database },
    };

    if (database === 'down') {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
