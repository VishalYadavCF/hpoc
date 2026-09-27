import { Module } from '@nestjs/common';
import {
  BudgetGrader, ContainsGrader, ExactGrader, JsonPathGrader, NotContainsGrader, RegexGrader,
} from './graders/deterministic.graders.js';
import { LlmJudgeGrader } from './graders/llm-judge.grader.js';
import { GraderRegistryImpl } from './graders/grader.registry.js';
import { GRADER_REGISTRY } from '../domain/ports/grader.port.js';
import { ModelProviderAdaptersModule } from './model-provider-adapters.module.js';
import { SecretAdaptersModule } from './secret-adapters.module.js';

/**
 * Eval graders. The LLM judge calls a provider directly with its own secret, outside any
 * run, so it takes the provider and secret bindings rather than the model gateway.
 */
@Module({
  imports: [ModelProviderAdaptersModule, SecretAdaptersModule],
  providers: [
    ExactGrader, ContainsGrader, NotContainsGrader, RegexGrader, JsonPathGrader,
    BudgetGrader, LlmJudgeGrader, GraderRegistryImpl,
    { provide: GRADER_REGISTRY, useExisting: GraderRegistryImpl },
  ],
  exports: [GRADER_REGISTRY],
})
export class GraderAdaptersModule {}
