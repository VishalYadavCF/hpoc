import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ApiModule } from '../src/api/api.module.js';
import { buildOpenApiDocument } from '../src/api/openapi/openapi.js';

/**
 * The reference is generated from the router, so these guard the two ways it can lie:
 * a route that exists but is undescribed, and a body documented differently from the
 * schema that rejects it.
 */
let app: INestApplication;
let doc: OpenAPIObject;

type Operation = { summary?: string; parameters?: { name: string; in: string }[]; requestBody?: unknown };
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete']);

const operations = (): [path: string, method: string, op: Operation][] =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item ?? {})
      .filter(([method]) => HTTP.has(method))
      .map(([method, op]) => [path, method, op as Operation] as [string, string, Operation]),
  );

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  doc = buildOpenApiDocument(app);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('the OpenAPI document', () => {
  it('covers every route the router serves', () => {
    // Not a fixed count: the assertion is that the document is generated FROM the router,
    // so a route added tomorrow appears without anyone remembering to list it here.
    expect(operations().length).toBeGreaterThan(100);
    expect(doc.paths['/v1/runs']?.post).toBeDefined();
    expect(doc.paths['/v1/threads/{id}/messages']?.get).toBeDefined();
  });

  it('describes every operation', () => {
    const undescribed = operations()
      .filter(([, , op]) => !op.summary)
      .map(([path, method]) => `${method.toUpperCase()} ${path}`);

    // A route in the reference with no description is worse than one that is absent: it
    // looks documented. New routes fail here until someone says what they do.
    expect(undescribed).toEqual([]);
  });

  it('declares the identity headers on tenanted routes, and not on the others', () => {
    const names = (path: string, method: 'get' | 'post') =>
      ((doc.paths[path] as Record<string, Operation>)[method]?.parameters ?? []).map((p) => p.name);

    expect(names('/v1/runs', 'post')).toEqual(expect.arrayContaining([
      'x-caller-subject', 'x-namespace', 'x-tenant-ref',
    ]));

    // Health has no tenant by design -- an orchestrator probing readiness has none, and
    // requiring one would make the pod permanently unready.
    expect(names('/healthz', 'get')).toEqual([]);
    // A webhook caller has no identity headers at all; the trigger row carries tenancy.
    const trigger = Object.keys(doc.paths).find((p) => p.startsWith('/v1/triggers'));
    expect(names(trigger!, 'post')).not.toContain('x-caller-subject');
  });

  it('generates request bodies from the Zod schema that validates them', () => {
    const body = (path: string, method: 'post') =>
      (
        (doc.paths[path] as Record<string, { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }>)[
          method
        ]?.requestBody?.content['application/json']?.schema ?? {}
      ) as { properties?: Record<string, unknown>; required?: string[] };

    const create = body('/v1/runs', 'post');
    expect(Object.keys(create.properties ?? {}).sort()).toEqual([
      'agent', 'delivery', 'input', 'mode', 'threadId',
    ]);
    // `agent` is the only field with no default, so it is the only one a caller must send.
    // That falls out of the schema rather than being asserted separately in prose.
    expect(create.required).toEqual(['agent']);

    // Documented as INPUT, so a field with a `.default()` is optional to send even though
    // it is always present once parsed.
    expect(create.properties?.['mode']).toMatchObject({ default: 'async' });
  });

  it('carries the acknowledgement a fork requires, because forking repeats effects', () => {
    const fork = (
      doc.paths['/v1/runs/{id}/fork'] as Record<
        string,
        { requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> } }
      >
    )['post']?.requestBody?.content['application/json']?.schema;

    // §4.2. If this field ever disappears from the schema it disappears from the docs too,
    // which is the property the whole generate-from-Zod approach is for.
    expect(fork?.properties).toHaveProperty('acknowledgeDuplicateEffects');
  });

  it('omits the HTML console from the API reference', () => {
    expect(doc.paths['/ui']).toBeUndefined();
  });
});
