import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

export interface DocOptions {
  /** One line, imperative. Shown as the route's title in the UI. */
  summary: string;
  /** Longer prose, where the route has a rule a caller must know about. */
  description?: string;
  /** The Zod schema the handler actually parses the body with. */
  body?: ZodType;
  /** The Zod schema describing a 2xx response, where one is written down. */
  response?: ZodType;
  /** Overrides the success status when it is not 200/201. */
  status?: number;
}

/**
 * Documents one route from the SAME Zod schema that validates it.
 *
 * ## Why not `class-validator` DTOs
 *
 * `@nestjs/swagger` generates schemas by reflecting over decorated classes. This codebase
 * validates with Zod, so going the DTO route would mean writing every request shape twice
 * -- once as the schema that runs and once as the class that is documented -- and the two
 * would diverge the first time someone edited one of them. A documented shape that does
 * not match the enforced shape is worse than no documentation: it is believed.
 *
 * Zod 4 emits JSON Schema natively, so the schema that rejects a bad request is the schema
 * the page renders. There is no second copy to drift.
 *
 * ## `io: 'input'`
 *
 * Requests are documented as INPUT: a field with a `.default()` is optional to send, even
 * though it is always present once parsed. Documenting the output shape would tell callers
 * that fields the platform fills in are required of them.
 */
export function Doc(options: DocOptions): MethodDecorator & ClassDecorator {
  const decorators: (MethodDecorator | ClassDecorator)[] = [
    ApiOperation({
      summary: options.summary,
      ...(options.description ? { description: options.description } : {}),
    }),
  ];

  if (options.body) {
    decorators.push(ApiBody({ schema: jsonSchema(options.body, 'input') }));
  }

  decorators.push(
    ApiResponse({
      status: options.status ?? 200,
      description: 'Success',
      // Responses are documented as OUTPUT: what the caller will actually receive, with
      // defaults resolved. The opposite convention from the request body, deliberately.
      ...(options.response ? { schema: jsonSchema(options.response, 'output') } : {}),
    }),
  );

  return applyDecorators(...(decorators as MethodDecorator[]));
}

/**
 * Zod to OpenAPI 3.1's flavour of JSON Schema.
 *
 * `$schema` is stripped because OpenAPI supplies its own dialect and a nested declaration
 * makes some tooling reject the document. `io` picks which side of a transform to render:
 * see the class comment.
 *
 * `unrepresentable: 'any'` rather than throwing: a schema carrying a refinement or a
 * transform JSON Schema cannot express should degrade to "any" in the docs, not take the
 * whole page down. The validation still runs either way -- only the description loosens.
 */
function jsonSchema(schema: ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _discarded, ...rest } = generated;
  return rest;
}
