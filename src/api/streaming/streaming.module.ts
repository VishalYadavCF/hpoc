import { Module } from '@nestjs/common';
import { RunStateModule } from '../../bootstrap/modules/run-state.module.js';
import { RunStreamService } from './run-stream.service.js';

/** SSE replay-then-tail over the event log, shared by the run and A2A surfaces. */
@Module({
  imports: [RunStateModule],
  providers: [RunStreamService],
  exports: [RunStreamService],
})
export class StreamingModule {}
