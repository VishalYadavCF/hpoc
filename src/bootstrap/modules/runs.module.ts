import { Module } from '@nestjs/common';
import { RunService } from '../../domain/run-engine/run.service.js';
import { RunReadService } from '../../domain/run-engine/run-read.service.js';
import { RunRecoveryService } from '../../domain/run-engine/run-recovery.service.js';
import { ReplayService } from '../../domain/run-engine/replay.service.js';
import { ThreadService } from '../../domain/thread/thread.service.js';
import { InteractionService } from '../../domain/interaction/interaction.service.js';
import { TriggerService } from '../../domain/trigger/trigger.service.js';
import { RunStateModule } from './run-state.module.js';
import { RegistryModule } from './registry.module.js';

/**
 * Managing runs from outside: creating them (directly, from a trigger or a schedule),
 * reading them, answering their interactions, forking, resuming and replaying them.
 *
 * Deliberately without the execution engine. Everything here writes rows and enqueues;
 * driving a run is the worker's job, in ExecutionModule.
 */
@Module({
  imports: [RunStateModule, RegistryModule],
  providers: [
    RunService,
    RunReadService,
    RunRecoveryService,
    ReplayService,
    ThreadService,
    InteractionService,
    TriggerService,
  ],
  exports: [
    RunService,
    RunReadService,
    RunRecoveryService,
    ReplayService,
    ThreadService,
    InteractionService,
    TriggerService,
  ],
})
export class RunsModule {}
