import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * PrismaClient as an injectable singleton, tied to the Nest lifecycle.
 *
 * Prisma 7 takes its connection from a driver adapter rather than a URL in the
 * schema, so the pool is configured here in application code. The Prisma CLI
 * reads its URL separately from prisma.config.ts; both read DATABASE_URL, so
 * they agree, but they are two different code paths and changing one does not
 * change the other.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');

    super({
      adapter: new PrismaPg({
        connectionString,
        // Nest holds one PrismaService for the process lifetime, so this pool
        // is the process's entire budget against Postgres. max_connections is
        // 200; leaving room for migrations, psql and a second replica matters
        // more than the throughput a larger pool would buy on a dev box.
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect during bootstrap rather than lazily on first query, so a bad
    // DATABASE_URL fails at startup instead of inside the first request.
    await this.$connect();
    this.logger.log('connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Round-trips a trivial query. Used by the health endpoint: `$connect()`
   * succeeding at boot says nothing about whether the connection is still
   * usable now.
   */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        `ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
