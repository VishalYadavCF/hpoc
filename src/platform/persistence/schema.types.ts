import type { Selectable } from 'kysely';
import type { DB, EvalCases, EvalRuns, EvalSuites, PeerTasks } from './schema.generated.js';

/**
 * Typed surface over the migrated schema.
 *
 * schema.generated.ts is produced by `npm run db:types` from a database migrated with
 * db/migrations/, and `npm run db:types:check` fails when the two disagree. Edit
 * .kysely-codegenrc.json, never the generated file: that is where json/jsonb columns
 * are typed as JSON text on insert, and where text columns constrained by a CHECK
 * are narrowed to their allowed values.
 */
export type Database = DB;

export type { DataClass, DurabilityTier, EffectClass, RunStatus } from './schema.generated.js';

// Text columns narrowed by a CHECK, not Postgres enums, so they have no generated name.
export type PeerTaskState = Selectable<PeerTasks>['state'];
export type Mechanism = NonNullable<Selectable<EvalSuites>['mechanism_under_test']>;
export type GraderKindValue = Selectable<EvalCases>['grader'];
export type EvalVerdict = NonNullable<Selectable<EvalRuns>['verdict']>;
