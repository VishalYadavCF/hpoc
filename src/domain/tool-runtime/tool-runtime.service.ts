import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';
import { SANDBOX, type Sandbox } from '../ports/sandbox.port.js';
import { CredentialBroker } from '../identity/credential-broker.service.js';
import { MCP_CLIENT, type McpClient } from '../ports/mcp-client.port.js';
import { McpRegistryService } from '../mcp/mcp-registry.service.js';
import { IndeterminateSideEffect, NotFound } from '../errors/platform.errors.js';
import { newId } from '../../platform/ids.js';

export interface ToolBinding {
  toolId: string;
  ref: string;
  origin: 'native' | 'http' | 'function' | 'mcp' | 'peer';
  version: number;
  effects: EffectClass[];
  endpointUrl: string | null;
  sandboxProfile: string;
  timeoutMs: number;
  definitionHash: string | null;
  idempotencyKeyTpl: string | null;
  cacheTtlSeconds: number | null;
  /**
   * Arguments the platform binds and the MODEL NEVER SEES (§18.5, ai-agent's `fixed`
   * field mode).
   *
   * Merged over the model's arguments, not under them: a pinned value is the author's
   * decision and a model that guessed the same key must not be able to override it.
   */
  fixedArgs: Record<string, unknown>;
  description: string | null;
  inputSchema: unknown;
  mcpServerId?: string | null;
  mcpToolName?: string | null;
  /** §8.1 registered request shape, so an HTTP tool is data rather than a shim service. */
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string | null;
  argPlacement: 'query' | 'body' | 'none' | null;
  staticHeaders: Record<string, string>;
  /** §8.1 `origin = 'function'`: the body the sandbox runs. Null for outbound-call tools. */
  codeRuntime: 'node' | 'python' | null;
  codeSource: string | null;
}

export type ToolOutcome =
  | { kind: 'completed'; invocationId: string; output: unknown; cached: boolean }
  | { kind: 'failed'; invocationId: string; error: { message: string; retryable: boolean } }
  | { kind: 'needs_approval'; invocationId: null; toolRef: string };

const has = (effects: EffectClass[], e: EffectClass): boolean => effects.includes(e);

/**
 * Executes one tool call, with the strategy selected by its declared effect contract.
 *
 * The effect array is not documentation. It picks the execution path, and that is the
 * whole point of §8.3 -- it is what makes §4.5's guarantees honest instead of aspirational.
 */
@Injectable()
export class ToolRuntime {
  private readonly log = new Logger(ToolRuntime.name);
  /** In-memory result cache. NEVER consulted during replay -- see execute() below (§10). */
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SANDBOX) private readonly sandbox: Sandbox,
    @Inject(MCP_CLIENT) private readonly mcp: McpClient,
    private readonly mcpRegistry: McpRegistryService,
    private readonly broker: CredentialBroker,
  ) {}

  async bindingsFor(agentVersionId: string): Promise<ToolBinding[]> {
    const rows = await this.db
      .selectFrom('agent_version_tools as avt')
      .innerJoin('tools as t', 't.id', 'avt.tool_id')
      .select((eb) => [
        'avt.tool_id', 'avt.idempotency_key_tpl', 'avt.cache_ttl_seconds', 'avt.fixed_args',
        't.ref', 't.origin', 't.version', 't.endpoint_url', 't.sandbox_profile',
        't.timeout_ms', 't.definition_hash', 't.description', 't.input_schema',
        't.http_method', 't.path_template', 't.arg_placement', 't.static_headers',
        't.code_runtime', 't.code_source',
        't.mcp_server_id', 't.mcp_tool_name',
        // See admission.service.ts: a custom enum array needs the cast to become an array.
        sql<EffectClass[]>`avt.effects::text[]`.as('effects'),
      ])
      .where('avt.agent_version_id', '=', agentVersionId)
      .execute();

    return rows.map((r) => ({
      toolId: r.tool_id,
      ref: r.ref,
      origin: r.origin,
      version: r.version,
      effects: r.effects,
      endpointUrl: r.endpoint_url,
      sandboxProfile: r.sandbox_profile,
      timeoutMs: r.timeout_ms,
      httpMethod: r.http_method,
      pathTemplate: r.path_template,
      argPlacement: r.arg_placement,
      staticHeaders: (r.static_headers ?? {}) as Record<string, string>,
      codeRuntime: r.code_runtime,
      codeSource: r.code_source,
      definitionHash: r.definition_hash,
      idempotencyKeyTpl: r.idempotency_key_tpl,
      fixedArgs: (r.fixed_args ?? {}) as Record<string, unknown>,
      cacheTtlSeconds: r.cache_ttl_seconds,
      description: r.description,
      inputSchema: r.input_schema,
      mcpServerId: r.mcp_server_id,
      mcpToolName: r.mcp_tool_name,
    }));
  }

  /**
   * §4.5's recovery rule, and the most important three lines in this file.
   *
   * A resumed run that finds one of its own non-idempotent invocations still `running`
   * does not know whether the side effect happened. It may not retry, and it may not
   * assume success. It says so.
   */
  async assertNoIndeterminateInvocations(runId: string): Promise<void> {
    const stuck = await this.db
      .selectFrom('tool_invocations as ti')
      .innerJoin('tools as t', 't.id', 'ti.tool_id')
      .select((eb) => [
        'ti.id', 't.ref',
        sql<EffectClass[]>`ti.effects::text[]`.as('effects'),
      ])
      .where('ti.run_id', '=', runId)
      .where('ti.status', '=', 'running')
      .execute();

    for (const row of stuck) {
      if (has(row.effects, 'non_idempotent')) {
        throw new IndeterminateSideEffect(row.id, row.ref);
      }
    }
  }

  async execute(args: {
    tx: Tx;
    binding: ToolBinding;
    stepId: string;
    runId: string;
    threadId: string;
    orgId: string;
    namespaceId: string;
    tenantRef: string;
    agentWorkloadId: string;
    onBehalfOf: string | null;
    toolArgs: Record<string, unknown>;
    replaying: boolean;
    /** Set only when a resolved Interaction authorised this exact invocation. */
    approved?: boolean;
  }): Promise<ToolOutcome> {
    const { tx, binding } = args;

    // Bound arguments applied BEFORE anything else reads the arguments, so the
    // idempotency key, the cache key and the recorded request all describe the call that
    // was actually made. Spread last: a pinned value is the author's decision, and a model
    // that guessed the same key must not be able to override it (§18.5).
    args = { ...args, toolArgs: mergeFixedArgs(args.toolArgs, binding.fixedArgs) };

    // Gated before execution, not after: the Interaction IS the gate (§8.3, §14).
    if (has(binding.effects, 'human_approval_required') && !args.approved) {
      return { kind: 'needs_approval', invocationId: null, toolRef: binding.ref };
    }

    const idempotencyKey = binding.idempotencyKeyTpl
      ? renderKey(binding.idempotencyKeyTpl, { runId: args.runId, stepId: args.stepId })
      : null;

    // Effectively-once for tools that declare support (§4.5). A prior attempt that
    // already owns this key wins; we reuse its result rather than calling twice.
    if (idempotencyKey && has(binding.effects, 'idempotent')) {
      const prior = await tx
        .selectFrom('tool_invocations')
        .select(['id', 'response', 'status'])
        .where('tool_id', '=', binding.toolId)
        .where('idempotency_key', '=', idempotencyKey)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (prior) {
        return { kind: 'completed', invocationId: prior.id, output: prior.response, cached: true };
      }
    }

    const invocationId = newId();
    const cacheKey = `${binding.toolId}:${JSON.stringify(args.toolArgs)}`;
    const cacheable = has(binding.effects, 'cacheable') && has(binding.effects, 'read_only');

    // §10's hard rule: a cache hit and a cache miss must produce IDENTICAL replayable
    // history. So a hit still writes the invocation row and still emits the event
    // carrying the output -- the cache only skips the call. During replay the cache is
    // not consulted at all; the recorded event is the truth.
    let cached: { value: unknown } | undefined;
    if (cacheable && !args.replaying) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) cached = { value: hit.value };
      else if (hit) this.cache.delete(cacheKey);
    }

    await tx
      .insertInto('tool_invocations')
      .values({
        id: invocationId,
        step_id: args.stepId,
        run_id: args.runId,
        thread_id: args.threadId,
        org_id: args.orgId,
        namespace_id: args.namespaceId,
        tenant_ref: args.tenantRef,
        tool_id: binding.toolId,
        origin: binding.origin,
        effects: binding.effects,
        definition_hash: binding.definitionHash,
        tool_version: binding.version,
        idempotency_key: idempotencyKey,
        authorized_principal_id: args.onBehalfOf,
        sandbox_profile: binding.sandboxProfile,
        request: JSON.stringify(args.toolArgs),
        // Written as `running` BEFORE the call, deliberately. That row is what a resumed
        // run reads to discover a non-idempotent invocation of unknown outcome.
        status: 'running',
        started_at: sql`now()`,
      })
      .execute();

    if (cached) {
      await this.settle(tx, invocationId, 'succeeded', cached.value, null);
      return { kind: 'completed', invocationId, output: cached.value, cached: true };
    }

    // Short-lived, audience-restricted, minted per call, handed to the sandbox and never
    // into model context (§16.3).
    const grant = await this.broker.mint(tx, {
      orgId: args.orgId,
      runId: args.runId,
      stepId: args.stepId,
      workloadIdentityId: args.agentWorkloadId,
      onBehalfOfPrincipalId: args.onBehalfOf,
      audience: binding.endpointUrl ?? binding.ref,
      scopes: [`tool:${binding.ref}`],
      tenantRef: args.tenantRef,
    });

    // §8.1: the engine treats all origins identically -- same invocation record, same
    // durability, same authorization -- while preserving protocol metadata. The dispatch
    // below is the only place origin changes anything.
    const result =
      binding.origin === 'mcp'
        ? await this.callMcp(binding, args, grant.headers)
        : await this.sandbox.execute({
            profile: binding.sandboxProfile,
            toolRef: binding.ref,
            headers: grant.headers,
            endpointUrl: binding.endpointUrl,
            args: args.toolArgs,
            timeoutMs: binding.timeoutMs,
            http: {
              method: binding.httpMethod,
              pathTemplate: binding.pathTemplate,
              argPlacement: binding.argPlacement,
              staticHeaders: binding.staticHeaders,
            },
            // Present only for a function tool. The sandbox refuses a container profile
            // with no body rather than running an entrypoint that does nothing (§0.4).
            ...(binding.codeRuntime && binding.codeSource
              ? { code: { runtime: binding.codeRuntime, source: binding.codeSource } }
              : {}),
          });

    if (!result.ok) {
      await this.settle(tx, invocationId, 'failed', null, result.error ?? null);
      return {
        kind: 'failed',
        invocationId,
        error: result.error ?? { message: 'unknown tool failure', retryable: false },
      };
    }

    if (cacheable) {
      this.cache.set(cacheKey, {
        value: result.output,
        expiresAt: Date.now() + (binding.cacheTtlSeconds ?? 60) * 1000,
      });
    }

    await this.settle(tx, invocationId, 'succeeded', result.output, null);
    return { kind: 'completed', invocationId, output: result.output, cached: false };
  }

  /**
   * Invokes an MCP tool, re-verifying its approval and definition hash first.
   *
   * Checked on every call rather than at binding time: an approval revoked a minute ago
   * must stop the next call, and a server that mutated a definition since the agent was
   * published must fail closed rather than be trusted because it once passed review.
   */
  private async callMcp(
    binding: ToolBinding,
    args: { namespaceId: string; tenantRef: string; toolArgs: Record<string, unknown> },
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; output?: unknown; error?: { message: string; retryable: boolean }; instanceId: string }> {
    if (!binding.mcpServerId || !binding.mcpToolName) {
      return {
        instanceId: 'mcp',
        ok: false,
        error: { message: `Tool ${binding.ref} is MCP-origin but names no server`, retryable: false },
      };
    }

    try {
      const server = await this.mcpRegistry.resolveForCall(
        binding.mcpServerId,
        binding.mcpToolName,
        binding.definitionHash,
        args.tenantRef,
        args.namespaceId,
      );
      const result = await this.mcp.callTool(
        // Broker-minted headers, never a stored credential (§13.2 no token passthrough).
        { ...server, headers },
        binding.mcpToolName,
        args.toolArgs,
        binding.timeoutMs,
      );
      return {
        instanceId: `mcp:${server.name}`,
        ok: result.ok,
        output: result.content,
        error: result.error,
      };
    } catch (e) {
      // A closed gate is not retryable: retrying a revoked approval just fails again.
      return {
        instanceId: 'mcp',
        ok: false,
        error: { message: (e as Error).message, retryable: false },
      };
    }
  }

  private async settle(
    tx: Tx,
    id: string,
    status: 'succeeded' | 'failed',
    response: unknown,
    error: unknown,
  ): Promise<void> {
    await tx
      .updateTable('tool_invocations')
      .set({
        status,
        response: response === undefined ? null : JSON.stringify(response),
        error: error ? JSON.stringify(error) : null,
        ended_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async requireBinding(agentVersionId: string, ref: string): Promise<ToolBinding> {
    const binding = (await this.bindingsFor(agentVersionId)).find((b) => b.ref === ref);
    // An unbound tool is a rejection, never a silent skip: §17.5 forbids silent narrowing,
    // and a model told a tool exists must not find it quietly absent.
    if (!binding) throw new NotFound('tool binding', ref);
    return binding;
  }
}

const renderKey = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\$\{(\w+)\}/g, (_, k: string) => vars[k] ?? `\${${k}}`);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Applies bound arguments, merging INTO nested objects rather than replacing them.
 *
 * A shallow spread was wrong for any tool whose arguments are nested. ap-executor's `ai-agent-v2`
 * is the case that exposed it: a Relay piece call puts the model's arguments under `input`, so a
 * pinned field has to be `fixedArgs.input.<field>` — and a shallow merge replaced the model's ENTIRE
 * `input` with just the pinned keys, silently dropping everything the model supplied. The practical
 * effect was that `fixed` and `agent` fields could not coexist on one tool, which is exactly what
 * pinning a spreadsheet id while the model fills the row requires.
 *
 * FIXED STILL WINS at every leaf — that is the security property (§18.5) and it is unchanged: a
 * model that guesses a pinned key cannot override it, at any depth. Only the "replace vs merge"
 * behaviour for object-valued keys changes. Arrays are replaced wholesale, not concatenated: a
 * pinned list is a complete statement of what the value is, not a contribution to one.
 */
function mergeFixedArgs(
  modelArgs: Record<string, unknown>,
  fixedArgs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...modelArgs };

  for (const [key, pinned] of Object.entries(fixedArgs)) {
    const existing = out[key];
    out[key] =
      isPlainObject(pinned) && isPlainObject(existing)
        ? mergeFixedArgs(existing, pinned)
        : pinned;
  }
  return out;
}
