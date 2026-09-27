import { Module } from '@nestjs/common';
import { GovernanceModule } from '../../bootstrap/modules/governance.module.js';
import { UiController } from '../ui/ui.controller.js';
import { OpsController } from './ops.controller.js';

/** The operator surface: console UI, health, readiness, metrics and /v1/ops. */
@Module({
  imports: [GovernanceModule],
  controllers: [UiController, OpsController],
})
export class OpsHttpModule {}
