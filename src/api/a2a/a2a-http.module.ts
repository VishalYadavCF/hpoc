import { Module } from '@nestjs/common';
import { RegistryModule } from '../../bootstrap/modules/registry.module.js';
import { RunsModule } from '../../bootstrap/modules/runs.module.js';
import { RunStateModule } from '../../bootstrap/modules/run-state.module.js';
import { StreamingModule } from '../streaming/streaming.module.js';
import { A2aController } from './a2a.controller.js';

/** Outside /v1 and outside the tenant middleware: a peer authenticates as a peer. */
@Module({
  imports: [RegistryModule, RunsModule, RunStateModule, StreamingModule],
  controllers: [A2aController],
})
export class A2aHttpModule {}
