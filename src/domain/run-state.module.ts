import { Module } from '@nestjs/common';
import { QueueService } from './queue/queue.service.js';
import { EventLog } from './event-log/event-log.service.js';
import { CheckpointService } from './checkpoint/checkpoint.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { ParentWaker } from './run-engine/parent-waker.service.js';

/**
 * A run's durable state: its queue lease, event log, checkpoints, outbox and parent wake-up.
 *
 * Shared by all three processes. The api writes the first event and queue entry, the worker
 * drives runs through them, and the scheduler reclaims, dead-letters and delivers. None of
 * that needs the execution engine, and keeping these primitives out of it is what lets the
 * scheduler run without one.
 */
@Module({
  providers: [QueueService, EventLog, CheckpointService, OutboxService, ParentWaker],
  exports: [QueueService, EventLog, CheckpointService, OutboxService, ParentWaker],
})
export class RunStateModule {}
