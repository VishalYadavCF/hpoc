import { Module } from '@nestjs/common';
import { EvalService } from '../../domain/eval/eval.service.js';
import { EvalSuiteService } from '../../domain/eval/suite.service.js';
import { GraderAdaptersModule } from '../../adapters/grader-adapters.module.js';
import { RegistryModule } from './registry.module.js';
import { RunsModule } from './runs.module.js';

/**
 * Eval suites and eval runs. Promotion gates live with deployments in RegistryModule: they
 * READ eval results, and importing this module from there would close the cycle
 * agents -> evals -> runs -> agents.
 */
@Module({
  imports: [RegistryModule, RunsModule, GraderAdaptersModule],
  providers: [EvalService, EvalSuiteService],
  exports: [EvalService, EvalSuiteService],
})
export class EvalsModule {}
