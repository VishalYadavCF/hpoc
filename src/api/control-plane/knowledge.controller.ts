import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { requireContext } from '../../platform/context/platform-context.js';
import { KnowledgeService } from '../../domain/knowledge/knowledge.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const collectionBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).nullish(),
});

const documentBody = z.object({
  body: z.string().min(1).max(2_000_000),
  title: z.string().max(500).nullish(),
  sourceUri: z.string().max(2_000).nullish(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  chunking: z
    .object({
      maxChars: z.number().int().min(200).max(8_000),
      overlapChars: z.number().int().min(0).max(1_000),
    })
    .optional(),
});

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PlatformError('admission_rejected', 'Malformed request', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
};

/**
 * Curated corpora (§6.1 semantic tier, authored rather than learned).
 *
 * Ingestion is synchronous on purpose at this size: it is chunk, embed, insert, and the
 * caller wants to know the corpus is queryable before it publishes an agent that depends
 * on it. A background job would return 202 and leave "is my agent grounded yet?"
 * unanswerable at exactly the moment it matters. Documents large enough to make that
 * wrong belong behind the artifact path, not behind a longer HTTP timeout.
 */
@ApiTags('knowledge')
@Controller('v1/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Doc({
    summary: 'List knowledge collections',
  })
  @Get('collections')
  async listCollections(): Promise<unknown> {
    const ctx = requireContext();
    return { collections: await this.knowledge.listCollections(ctx.namespaceId) };
  }

  @Doc({
    summary: 'Create a knowledge collection',
  })
  @Post('collections')
  async createCollection(@Body() body: unknown): Promise<unknown> {
    const ctx = requireContext();
    const input = parse(collectionBody, body);
    return this.knowledge.createCollection({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      name: input.name,
      description: input.description ?? null,
      createdBy: ctx.callerPrincipalId,
    });
  }

  @Doc({
    summary: 'List documents in a collection',
  })
  @Get('collections/:id/documents')
  async listDocuments(@Param('id') id: string): Promise<unknown> {
    return { documents: await this.knowledge.listDocuments(id) };
  }

  @Doc({
    summary: 'Ingest a document',
  })
  @Post('collections/:id/documents')
  async ingest(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const ctx = requireContext();
    const input = parse(documentBody, body);
    return this.knowledge.ingest({
      orgId: ctx.orgId,
      collectionId: id,
      body: input.body,
      title: input.title ?? null,
      sourceUri: input.sourceUri ?? null,
      metadata: input.metadata,
      ...(input.chunking ? { chunking: input.chunking } : {}),
    });
  }

  @Doc({
    summary: 'Delete a document',
  })
  @Delete('collections/:id/documents/:documentId')
  async deleteDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ): Promise<unknown> {
    const deleted = await this.knowledge.deleteDocument(id, documentId);
    if (!deleted) throw new PlatformError('not_found', `Document ${documentId} not found`);
    return { deleted: true, note: 'Its chunks were removed from the index with it.' };
  }

  /**
   * Search, exposed so a corpus can be evaluated WITHOUT running an agent.
   *
   * "The agent gave a bad answer" has at least two causes -- retrieval surfaced the wrong
   * passages, or the model misused the right ones -- and they are fixed in different
   * places. Without this endpoint the two are indistinguishable from the outside.
   */
  @Doc({
    summary: 'Search a collection',
  })
  @Get('collections/:id/search')
  async search(@Param('id') id: string, @Query('q') q?: string): Promise<unknown> {
    if (!q) throw new PlatformError('admission_rejected', 'Query parameter "q" is required');
    const hits = await this.knowledge.search({ collectionIds: [id], text: q, limit: 10 });
    return { query: q, hits };
  }
}
