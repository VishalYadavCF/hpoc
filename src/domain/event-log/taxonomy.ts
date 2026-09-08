/** §15.1's unified taxonomy. One vocabulary for native, MCP, A2A and gateway alike. */
export const EventType = {
  RunCreated: 'run.created',
  RunStarted: 'run.started',
  RunCheckpointed: 'run.checkpointed',
  RunWaiting: 'run.waiting',
  RunResumed: 'run.resumed',
  RunCompleted: 'run.completed',
  RunFailed: 'run.failed',
  RunCancelled: 'run.cancelled',
  RunDeadLettered: 'run.dead_lettered',

  StepStarted: 'step.started',
  StepCompleted: 'step.completed',
  StepFailed: 'step.failed',

  ModelRequested: 'model.requested',
  ModelCompleted: 'model.completed',
  ModelFallback: 'model.fallback',

  ToolCalled: 'tool.called',
  ToolCompleted: 'tool.completed',
  ToolFailed: 'tool.failed',

  InteractionCreated: 'interaction.created',
  InteractionResolved: 'interaction.resolved',
  InteractionExpired: 'interaction.expired',

  CacheHit: 'cache.hit',
  CacheMiss: 'cache.miss',

  // §15.1: A2A activity enters the SAME taxonomy. A separate a2a event stream would be
  // the "second event store" §13.4 rules out.
  PeerTaskCreated: 'a2a.task.created',
  PeerTaskProgress: 'a2a.task.progress',
  PeerTaskCompleted: 'a2a.task.completed',
  PeerTaskFailed: 'a2a.task.failed',

  StreamConnected: 'stream.connected',
  StreamResumed: 'stream.resumed',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/**
 * Current schema version for newly written events.
 *
 * §0.2: bump this whenever an event payload's shape changes, and register an upcaster
 * that lifts the previous version at read time. A change that breaks replay of the
 * archived corpus is a breaking change.
 */
export const CURRENT_EVENT_SCHEMA_VERSION = 2;
