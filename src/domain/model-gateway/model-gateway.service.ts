import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import type { DataClass } from '../../platform/persistence/schema.types.js';
import type {
  ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk,
} from '../ports/model-provider.port.js';
import { CredentialBroker } from '../identity/credential-broker.service.js';
import { RESPONSE_CACHE, type ResponseCache } from '../ports/response-cache.port.js';
import { stableHash } from '../../platform/ids.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';

export interface GatewayResult extends ModelResponse {
  modelId: string;
  provider: string;
  cached: boolean;
  /** Set when routing fell back; the run must be diagnosable without reading logs (§9). */
  fellBackFromModelId: string | null;
  costMicros: number;
}

export interface GatewayStream {
  /** Incremental output. Consuming this to completion is what resolves `settled`. */
  chunks: AsyncIterable<ModelStreamChunk>;
  /**
   * The accounting result, available once the stream ends. `partial` is true when the
   * stream was cut short -- aborted by barge-in, or failed after the first chunk -- and it
   * is what stops a truncated answer being cached or billed as a complete one.
   */
  settled: Promise<GatewayResult & { partial: boolean }>;
}

/**
 * The single path from agent to provider (§9).
 *
 * It exists so residency, cost and capability policy have exactly one place to live. It
 * is a control point, not a proxy for convenience -- which is why the residency gate
 * below is a hard refusal rather than a warning.
 */
@Injectable()
export class ModelGateway {
  private readonly log = new Logger(ModelGateway.name);
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly broker: CredentialBroker,
    @Inject(RESPONSE_CACHE) private readonly cache: ResponseCache,
  ) {}

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  async complete(args: {
    tx: Tx;
    modelId: string;
    agentDataClass: DataClass;
    request: Omit<ModelRequest, 'providerModelId'>;
    orgId: string;
    runId: string;
    stepId: string;
    workloadIdentityId: string;
    onBehalfOfPrincipalId: string | null;
    tenantRef: string;
    /** Declared per agent (§10); never inferred from the request. */
    cache?: { modelResponses: boolean; ttlSeconds: number };
  }): Promise<GatewayResult> {
    const model = await this.loadModel(args.modelId);

    // §16.1 Constraint 2, enforced here and only here. An agent marked `regulated` is
    // structurally unable to reach an external provider, regardless of what its spec
    // names -- because the only path to a provider is through this method.
    if (args.agentDataClass === 'regulated' && model.residency === 'external') {
      throw new PlatformError(
        'capability_denied',
        `Agent is classified regulated and model ${model.ref} is external`,
        { modelRef: model.ref, residency: model.residency },
      );
    }

    const provider = this.providers.get(model.provider);
    if (!provider) throw new NotFound('model provider', model.provider);

    // Keyed by tenant as well as by prompt: two tenants asking the same question must not
    // share an answer, however identical the request looks.
    const cacheKey =
      args.cache?.modelResponses && !args.request.tools?.length
        ? stableHash({
            tenant: args.tenantRef,
            model: model.id,
            prompt: args.request.prompt,
            // The transcript is part of the key, not decoration: two calls with the same
            // trailing prompt but different tool results before it are different
            // questions, and sharing an answer between them replays a stale result.
            messages: args.request.messages ?? null,
            system: args.request.systemPrompt ?? null,
          })
        : null;

    if (cacheKey) {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        // A hit still returns a full result, and the run loop still writes the step and
        // the event carrying the output — §10's identical-replayable-history rule.
        return this.toResult(model, hit, null, true);
      }
    }

    // Resolved per call, never held on the provider instance and never written to
    // process.env: under concurrency that is how one tenant's key reaches another
    // tenant's request (§16.3).
    const credentials = await this.credentialsFor(args, model);

    try {
      const response = await this.completeNonEmpty(
        model.ref,
        () => provider.complete(this.providerRequest(args.request, model), credentials),
      );
      // Never cache a response carrying tool calls: the arguments are situational, and
      // replaying them would invoke a side effect for a different question.
      if (cacheKey && !response.toolCalls?.length) {
        await this.cache.set(cacheKey, response, args.cache!.ttlSeconds);
      }
      return this.toResult(model, response, null);
    } catch (e) {
      if (!model.fallback_model_id) throw e;

      this.log.warn(
        `model ${model.ref} failed (${(e as Error).message}); falling back to ${model.fallback_model_id}`,
      );
      const fallback = await this.loadModel(model.fallback_model_id);
      if (args.agentDataClass === 'regulated' && fallback.residency === 'external') throw e;

      const fallbackProvider = this.providers.get(fallback.provider);
      if (!fallbackProvider) throw e;

      // The fallback is a different provider with a different secret. Reusing the first
      // model's credentials would 401 and look like the fallback itself failing.
      const fallbackCredentials = await this.credentialsFor(args, fallback);
      const response = await this.completeNonEmpty(
        fallback.ref,
        () => fallbackProvider.complete(this.providerRequest(args.request, fallback), fallbackCredentials),
      );
      return this.toResult(fallback, response, model.id);
    }
  }

  /**
   * A completion with no text AND no tool call is a provider failure, not an answer.
   *
   * Gemini returns exactly that intermittently -- zero output tokens, and a finish reason such as
   * `MALFORMED_FUNCTION_CALL` when it tried to call a tool and produced something unparseable. It
   * used to flow straight through: the framework read "no tool call" as "done", the run was marked
   * `completed` with an empty answer, and an A2A caller was told the work succeeded when nothing
   * had been done at all. Measured on relay-workflow-manager: a create request, one model step,
   * 7,481 input tokens, 0 output, run `completed`, no workflow created.
   *
   * Retried once on the same model, because in practice the next attempt usually answers. A
   * second empty is thrown as `upstream_failure`, which is what the fallback model -- or the
   * run's own failure path -- exists to handle. No empty completion reaches the framework.
   */
  private async completeNonEmpty(
    modelRef: string,
    call: () => Promise<ModelResponse>,
  ): Promise<ModelResponse> {
    let response = await call();
    if (!isEmptyCompletion(response)) return response;

    this.log.warn(
      `model ${modelRef} returned an empty completion (finishReason=${response.finishReason ?? 'unknown'}); retrying once`,
    );
    response = await call();
    if (!isEmptyCompletion(response)) return response;

    throw new PlatformError(
      'upstream_failure',
      `Model ${modelRef} returned an empty completion twice (finishReason=${response.finishReason ?? 'unknown'})`,
      { modelRef, finishReason: response.finishReason ?? null },
    );
  }


  /**
   * The request as the provider should see it, with the registry's own ceiling applied.
   *
   * `models.max_output_tokens` was stored and then never read: nothing set
   * `ModelRequest.maxOutputTokens`, so every call ran on the vendor's default. That is invisible
   * on a normal model and fatal on a REASONING one — gemini-2.5-flash spent the whole default
   * budget on thoughts and returned an empty answer with no tool calls, as a `completed`, billed
   * run. An explicit ceiling from the registry is what the column was for.
   *
   * A caller that names its own limit still wins: this is a default, not a cap.
   */
  private providerRequest(
    request: Omit<ModelRequest, 'providerModelId'>,
    model: { provider_model_id: string; max_output_tokens: number | null },
  ): ModelRequest {
    return {
      ...request,
      providerModelId: model.provider_model_id,
      maxOutputTokens: request.maxOutputTokens ?? model.max_output_tokens,
    };
  }

  private async credentialsFor(
    args: {
      tx: Tx; orgId: string; runId: string; stepId: string;
      workloadIdentityId: string; onBehalfOfPrincipalId: string | null; tenantRef: string;
    },
    model: { base_url: string | null; credential_ref: string | null; ref: string },
  ): Promise<Record<string, string>> {
    return this.broker.forModel(args.tx, {
      orgId: args.orgId,
      runId: args.runId,
      stepId: args.stepId,
      workloadIdentityId: args.workloadIdentityId,
      onBehalfOfPrincipalId: args.onBehalfOfPrincipalId,
      tenantRef: args.tenantRef,
      audience: model.base_url ?? model.ref,
      credentialRef: model.credential_ref,
      baseUrl: model.base_url,
    });
  }

  /** Attribution per §9: org / namespace / tenant / agent / run. Written with the step. */
  async recordUsage(
    tx: Tx,
    row: {
      orgId: string;
      namespaceId: string;
      tenantRef: string;
      agentVersionId: string;
      runId: string;
      stepId: string;
      modelId: string;
      provider: string;
      result: GatewayResult;
    },
  ): Promise<void> {
    await tx
      .insertInto('usage_ledger')
      .values({
        org_id: row.orgId,
        namespace_id: row.namespaceId,
        tenant_ref: row.tenantRef,
        agent_version_id: row.agentVersionId,
        run_id: row.runId,
        step_id: row.stepId,
        kind: 'model_tokens',
        model_id: row.modelId,
        provider: row.provider,
        input_tokens: String(row.result.inputTokens),
        output_tokens: String(row.result.outputTokens),
        cost_micros: String(row.result.costMicros),
      })
      .execute();
  }

  /**
   * Incremental generation through the same control point as `complete()` (§9, §12.3).
   *
   * Every guarantee `complete()` makes has to survive streaming, and three of them need a
   * decision rather than a copy:
   *
   *  - **Residency** is the same statement, evaluated before a byte is requested.
   *  - **Fallback happens only BEFORE the first chunk.** After it, output may already have
   *    reached the caller -- for voice, audio the user has heard -- and restarting on
   *    another model would repeat the sentence. Past that point the stream ends `partial`
   *    and the caller truncates, which is exactly what barge-in already does.
   *  - **A partial stream is never cached.** Replaying half an answer as though it were
   *    whole is worse than paying for the call again, and it escapes the run: the next
   *    tenant asking the same question would be served the truncation.
   */
  async stream(args: {
    modelId: string;
    agentDataClass: DataClass;
    request: Omit<ModelRequest, 'providerModelId'>;
    orgId: string;
    runId: string;
    stepId: string;
    workloadIdentityId: string;
    onBehalfOfPrincipalId: string | null;
    tenantRef: string;
    tx: Tx;
    cache?: { modelResponses: boolean; ttlSeconds: number };
    signal?: AbortSignal;
  }): Promise<GatewayStream> {
    const model = await this.loadModel(args.modelId);
    this.assertResidency(args.agentDataClass, model);

    const provider = this.providers.get(model.provider);
    if (!provider) throw new NotFound('model provider', model.provider);

    const cacheKey = this.cacheKeyFor(args, model);
    if (cacheKey) {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        // A hit yields the whole text as one chunk, so a cached turn and a live one produce
        // the same observable sequence -- §10's identical-replayable-history rule holds for
        // the streaming path too.
        const result = this.toResult(model, hit, null, true);
        return {
          chunks: (async function* () {
            if (hit.text) yield { textDelta: hit.text };
          })(),
          settled: Promise.resolve({ ...result, partial: false }),
        };
      }
    }

    const credentials = await this.credentialsFor(args, model);
    const request = this.providerRequest(args.request, model);

    let settle!: (r: GatewayResult & { partial: boolean }) => void;
    let fail!: (e: unknown) => void;
    const settled = new Promise<GatewayResult & { partial: boolean }>((res, rej) => {
      settle = res;
      fail = rej;
    });
    // Nothing awaits `settled` until the caller does, and an early provider failure would
    // otherwise be an unhandled rejection that takes the process down.
    void settled.catch(() => undefined);

    const self = this;
    const chunks = (async function* (): AsyncIterable<ModelStreamChunk> {
      let text = '';
      let first = true;
      try {
        for await (const chunk of self.iterate(provider, request, credentials, args.signal)) {
          if (chunk.textDelta) text += chunk.textDelta;
          first = false;
          yield chunk;
        }
      } catch (e) {
        if (!first || !model.fallback_model_id) {
          // Past the first chunk, or with nowhere to fall back to: end partial rather than
          // restart. `settled` resolves instead of rejecting because the caller has real
          // output in hand and needs the accounting for it.
          if (!first) {
            settle({
              ...self.toResult(model, self.approximate(request, text), null),
              partial: true,
            });
            return;
          }
          fail(e);
          throw e;
        }

        self.log.warn(
          `model ${model.ref} failed before first chunk (${(e as Error).message}); ` +
            `falling back to ${model.fallback_model_id}`,
        );
        const fallback = await self.loadModel(model.fallback_model_id);
        self.assertResidency(args.agentDataClass, fallback);
        const fallbackProvider = self.providers.get(fallback.provider);
        if (!fallbackProvider) {
          fail(e);
          throw e;
        }
        const fallbackRequest = self.providerRequest(args.request, fallback);
        let fallbackText = '';
        for await (const chunk of self.iterate(
          fallbackProvider,
          fallbackRequest,
          // A different provider with a different secret; reusing the first model's would
          // 401 and look like the fallback itself failing.
          await self.credentialsFor(args, fallback),
          args.signal,
        )) {
          if (chunk.textDelta) fallbackText += chunk.textDelta;
          yield chunk;
        }
        settle({
          ...self.toResult(fallback, self.approximate(fallbackRequest, fallbackText), model.id),
          partial: false,
        });
        return;
      }

      const response = self.approximate(request, text);
      if (cacheKey) await self.cache.set(cacheKey, response, args.cache!.ttlSeconds);
      settle({ ...self.toResult(model, response, null), partial: false });
    })();

    return { chunks, settled };
  }

  /** Native streaming where the provider has it; one chunk through `complete()` where not. */
  private async *iterate(
    provider: ModelProvider,
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk> {
    if (provider.stream) {
      yield* provider.stream(request, credentials, signal);
      return;
    }
    const response = await provider.complete(request, credentials, signal);
    if (response.text) yield { textDelta: response.text };
    for (const [index, call] of (response.toolCalls ?? []).entries()) {
      yield {
        toolCallDelta: {
          index,
          ...(call.id === undefined ? {} : { id: call.id }),
          name: call.name,
          argsDelta: JSON.stringify(call.args),
        },
      };
    }
  }

  /**
   * Token counts for a stream that did not report them.
   *
   * Labelled rather than fabricated: providers that stream often omit usage, and a
   * character-based estimate that is *known* to be an estimate is more useful than a
   * confident wrong number. `EchoProvider` already sets that precedent.
   */
  private approximate(request: ModelRequest, text: string): ModelResponse {
    const chars = (request.prompt.length + (request.systemPrompt?.length ?? 0)) / 4;
    return {
      text,
      inputTokens: Math.ceil(chars),
      outputTokens: Math.ceil(text.length / 4),
    };
  }

  private assertResidency(
    dataClass: DataClass,
    model: Awaited<ReturnType<ModelGateway['loadModel']>>,
  ): void {
    if (dataClass === 'regulated' && model.residency === 'external') {
      throw new PlatformError(
        'capability_denied',
        `Agent is classified regulated and model ${model.ref} is external`,
        { modelRef: model.ref, residency: model.residency },
      );
    }
  }

  private cacheKeyFor(
    args: { cache?: { modelResponses: boolean }; request: Omit<ModelRequest, 'providerModelId'>; tenantRef: string },
    model: { id: string },
  ): string | null {
    // Keyed by tenant as well as by prompt: two tenants asking the same question must not
    // share an answer, however identical the request looks. Never for a tool-bearing
    // request -- the arguments are situational.
    return args.cache?.modelResponses && !args.request.tools?.length
      ? stableHash({
          tenant: args.tenantRef,
          model: model.id,
          prompt: args.request.prompt,
          system: args.request.systemPrompt ?? null,
        })
      : null;
  }

  private toResult(
    model: Awaited<ReturnType<ModelGateway['loadModel']>>,
    response: ModelResponse,
    fellBackFrom: string | null,
    cached = false,
  ): GatewayResult {
    const inCost = Number(model.input_cost_micros_per_1k ?? 0);
    const outCost = Number(model.output_cost_micros_per_1k ?? 0);
    return {
      ...response,
      modelId: model.id,
      provider: model.provider,
      fellBackFromModelId: fellBackFrom,
      cached,
      // A cache hit costs nothing, and billing a tenant for a call that never happened
      // would be wrong in the direction that matters.
      costMicros: cached ? 0 : Math.round(
        (response.inputTokens / 1000) * inCost + (response.outputTokens / 1000) * outCost,
      ),
    };
  }

  private async loadModel(id: string) {
    const model = await this.db
      .selectFrom('models')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!model) throw new NotFound('model', id);
    return model;
  }
}

const isEmptyCompletion = (r: ModelResponse): boolean =>
  !r.text?.trim() && !(r.toolCalls?.length);
