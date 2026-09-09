import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Route prefixes the tenancy middleware does NOT cover, and why.
 *
 * Kept beside the middleware's own list in `api.module.ts` rather than derived from it:
 * deriving would couple the docs to a private field, and the two lists answer different
 * questions -- one is "who gets a context", the other is "what must a caller send".
 *
 * `v1/triggers` is the interesting one: an external webhook caller has no identity headers
 * at all, and the trigger row supplies the tenancy instead. Documenting the headers as
 * required there would tell integrators to send credentials they do not have.
 */
const UNTENANTED = ['/healthz', '/readyz', '/metrics', '/v1/triggers', '/v1/ops', '/v1/a2a', '/ui'];

/**
 * Tag descriptions, so the sidebar groups 148 operations into something navigable.
 *
 * These names must match the `@ApiTags` on the controllers EXACTLY. They did not, once:
 * Nest derives a tag from the controller class name when none is given, so
 * `RunsController` became `Runs` while this list declared `runs` -- and the UI rendered
 * twenty-one empty, unopenable sections above the real ones. A declared tag nothing uses
 * is invisible in the document and obvious in the browser, which is why the test below
 * asserts the two sets are equal rather than trusting this comment.
 */
const TAGS: [name: string, description: string][] = [
  ['runs', 'Start, read, stream, cancel, fork and replay runs (§4).'],
  ['threads', 'Multi-turn conversations and their transcripts (§3).'],
  ['interactions', 'Human-in-the-loop: approvals and questions raised mid-run (§14).'],
  ['agents', 'The agent registry: agents, versions and deployments (§17).'],
  ['memory', 'Recall, forget and the per-tenant memory tiers (§6).'],
  ['memory-sharing', 'Cross-tenant memory sharing, opt-in per namespace (§6).'],
  ['artifacts', 'Large step output, offloaded out of Postgres (§11.2).'],
  ['catalog', 'Tools available to bind, and their effect contracts (§8).'],
  ['prompts', 'Versioned, governed prompt registry (§17.2).'],
  ['policies', 'Policies a version pins and is admitted against (§17.3).'],
  ['skills', 'Versioned procedures an agent can pin (§17.2).'],
  ['knowledge', 'Authored corpora an agent can search (§6.5).'],
  ['mcp', 'MCP servers, tool discovery and definition-hash approval (§13.2).'],
  ['peers', 'A2A peers: another team, another trust domain (§13.4).'],
  ['evals', 'Eval suites, runs and variance (§0.5).'],
  ['deployments', 'Promotion gates, canary and shadow (§15.5).'],
  ['triggers', 'Inbound webhooks and schedules. No identity headers — the trigger carries tenancy.'],
  ['a2a', 'The agent-to-agent protocol surface (§13.4).'],
  ['observability', 'Traces, lineage, analytics and feedback (§9).'],
  ['replay', 'Replaying a run through a changed schema (§10).'],
  ['ops', 'Operator surface: queue depth, dead letters, subsystems. Spans every tenant (§5.2).'],
];

/**
 * The OpenAPI document, assembled from the running router.
 *
 * Route discovery is Nest's: paths, methods and path parameters come from the decorators
 * that actually route the request, so a route cannot exist without appearing here. What
 * `@Doc` adds on top is the request and response SHAPE, taken from the Zod schema that
 * validates it -- see `api-doc.decorator.ts` for why that is not a `class-validator` DTO.
 *
 * The consequence worth knowing: an undecorated route still appears, correctly, with no
 * body schema. Coverage degrades gracefully instead of the page being wrong.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('General Agent Platform')
    .setDescription(
      'Durable, multi-tenant agent execution.\n\n' +
        '**Every tenanted call needs three headers** — `x-caller-subject`, `x-namespace` ' +
        'and `x-tenant-ref`. Without them the request is refused before it reaches a ' +
        'controller, which is why they are declared on each operation rather than left to ' +
        'a prose note nobody reads.\n\n' +
        'Request bodies are generated from the Zod schemas that validate them, so a shape ' +
        'shown here is the shape that is enforced.',
    )
    .setVersion('1')
    .addTag('platform', 'Health, readiness and metrics. No tenancy.');

  for (const [name, description] of TAGS) builder.addTag(name, description);
  const names = ['platform', ...TAGS.map(([name]) => name)];

  const document = SwaggerModule.createDocument(app, builder.build(), {
    // Nest's default operation ids are `Controller_method`, which collide across
    // controllers that share a method name (`list`, `get`) and make generated clients
    // ambiguous. Path plus method is unique by construction.
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });

  return withTenancyHeaders(canonicalTags(document, new Set(names)));
}

/**
 * Drops the controller-derived tag Nest adds when a method declares its own.
 *
 * Nest tags an operation with its controller's class name (`OpsController` -> `Ops`) and
 * MERGES that with any `@ApiTags`, so an explicit tag adds a group rather than replacing
 * one. `/healthz` came out as `['Ops', 'platform']` and appeared twice.
 *
 * Filtering to the declared set fixes it with one rule instead of a special case per
 * controller, because the derived name is capitalised and no declared name is. The test
 * asserts every operation still has a tag afterwards, so filtering can never silently
 * empty the page.
 */
function canonicalTags(document: OpenAPIObject, declared: Set<string>): OpenAPIObject {
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item ?? {})) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      const op = operation as { tags?: string[] };
      const kept = (op.tags ?? []).filter((t) => declared.has(t));
      // A route on a controller nobody tagged keeps its derived name rather than losing
      // its group entirely -- wrong-looking beats invisible, and the test says which.
      if (kept.length > 0) op.tags = kept;
    }
  }
  return document;
}

/**
 * Declares the identity headers on every operation the middleware guards.
 *
 * Done as a document transform rather than a decorator on 151 routes for one reason
 * beyond effort: a route added tomorrow gets them automatically. A per-route decorator
 * would document the headers only where someone remembered, and the routes people forget
 * are exactly the ones a caller has not used before.
 */
function withTenancyHeaders(document: OpenAPIObject): OpenAPIObject {
  for (const [path, item] of Object.entries(document.paths)) {
    if (UNTENANTED.some((prefix) => path.startsWith(prefix))) continue;

    for (const operation of Object.values(item ?? {})) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      const op = operation as { parameters?: unknown[] };
      op.parameters = [...header('x-caller-subject', 'svc:demo-client', true,
                                 'The calling workload, as `svc:<name>` (§16.2).'),
                       ...header('x-namespace', 'demo', true,
                                 'Namespace slug. Scopes the registry and sub-agent resolution (§13.3).'),
                       ...header('x-tenant-ref', 'merchant-1', true,
                                 'The end tenant this call is on behalf of. Partitions memory and quota (§5.2).'),
                       ...header('x-on-behalf-of', undefined, false,
                                 'The interactive user, when one is present. Its absence is meaningful: ' +
                                 'it says no human was in the loop, which is a different security posture.'),
                       ...(op.parameters ?? [])];
    }
  }
  return document;
}

const header = (name: string, example: string | undefined, required: boolean, description: string) => [
  {
    name,
    in: 'header',
    required,
    description,
    schema: { type: 'string', ...(example ? { example } : {}) },
  },
];
