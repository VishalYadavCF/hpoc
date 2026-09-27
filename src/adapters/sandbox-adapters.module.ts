import { Module } from '@nestjs/common';
import { HttpEgressSandbox } from './sandbox/http-egress.sandbox.js';
import { ContainerSandbox } from './sandbox/container.sandbox.js';
import { SandboxRouter } from './sandbox/sandbox.router.js';
import { SANDBOX } from '../domain/ports/sandbox.port.js';

/**
 * The router IS the single boundary §0.4 asks for: the platform picks isolation from the
 * tool's declared profile, and a tool can never pick its own.
 */
@Module({
  providers: [
    HttpEgressSandbox,
    ContainerSandbox,
    SandboxRouter,
    { provide: SANDBOX, useExisting: SandboxRouter },
  ],
  exports: [SANDBOX],
})
export class SandboxAdaptersModule {}
