import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('HealthController', () => {
  let controller: HealthController;
  let ping: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ping = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { ping } }],
    }).compile();

    controller = module.get(HealthController);
  });

  describe('liveness', () => {
    it('reports ok without touching the database', () => {
      expect(controller.live()).toEqual({ status: 'ok' });
      expect(ping).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('reports ok when the database answers', async () => {
      ping.mockResolvedValue(true);

      await expect(controller.ready()).resolves.toEqual({
        status: 'ok',
        checks: { database: 'up' },
      });
    });

    it('fails with 503 when the database does not answer', async () => {
      ping.mockResolvedValue(false);

      // The status code is the part a probe reads, so assert on it rather
      // than only on the body.
      await expect(controller.ready()).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });

      await expect(controller.ready()).rejects.toBeInstanceOf(HttpException);
    });

    it('names the failing dependency in the body', async () => {
      ping.mockResolvedValue(false);

      const error = await controller.ready().catch((e: HttpException) => e);

      expect((error as HttpException).getResponse()).toEqual({
        status: 'degraded',
        checks: { database: 'down' },
      });
    });
  });
});
