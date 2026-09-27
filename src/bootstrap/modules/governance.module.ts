import { Module } from '@nestjs/common';
import { BudgetService } from '../../domain/governance/budget.service.js';
import { BackpressureService } from '../../domain/governance/backpressure.service.js';

/** Budgets and backpressure: the tenancy ceilings above any one run's own (§5.2). */
@Module({
  providers: [BudgetService, BackpressureService],
  exports: [BudgetService, BackpressureService],
})
export class GovernanceModule {}
