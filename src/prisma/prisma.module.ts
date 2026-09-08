import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global so feature modules can inject PrismaService without each importing
 * PrismaModule. The service wraps a connection pool that must be a singleton;
 * making the module global is the cheapest way to keep it one.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
